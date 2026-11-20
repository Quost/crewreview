//! Approve from the menu bar: what waits in the inbox, one submenu each, with approve (after a confirmation, since
//! it posts on the host), open in the dashboard, and discard.
use std::thread;

use serde_json::Value;
use tauri::menu::{IsMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;

use crate::crew;
use crate::strings::Strings;
use crate::window;

/// How many items the menu lists; the rest are in the dashboard.
pub const SHOWN: usize = 8;

#[derive(Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub fix: bool,
    /// `acme/shop#139` for the confirmation and the notifications.
    pub pr: String,
    pub title: String,
    pub label: String,
}

/// An inbox id the menu may act on: `r12` (a review) or `f7` (fixes and replies). Anything else is ignored.
pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some('r' | 'f')) && id.len() > 1 && chars.all(|c| c.is_ascii_digit())
}

/// The menu's entries for the inbox items, at most `SHOWN`, and how many more there are.
pub fn entries(items: &[Value]) -> (Vec<Entry>, usize) {
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str).filter(|id| valid_id(id)) else { continue };
        let repo = item.get("repo").and_then(Value::as_str).unwrap_or("");
        let number = item.get("number").and_then(Value::as_u64).unwrap_or(0);
        let title = item.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        let pr = format!("{repo}#{number}");
        let label = shorten(&format!("{pr} · {title}"), 56);
        out.push(Entry { id: id.to_string(), fix: id.starts_with('f'), pr, title, label });
    }
    let more = out.len().saturating_sub(SHOWN);
    out.truncate(SHOWN);
    (out, more)
}

fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    // At a space when there's one in the second half, so a word isn't cut.
    let cut: String = text.chars().take(max - 1).collect();
    let cut = match cut.rfind(' ') {
        Some(i) if i > cut.len() / 2 => cut[..i].to_string(),
        _ => cut,
    };
    format!("{}…", cut.trim_end())
}

/// Fill the inbox submenu again: one submenu per item, then "more" and "open the inbox".
pub fn fill(app: &AppHandle, menu: &Submenu<Wry>, items: &[Value], strings: &Strings) -> tauri::Result<()> {
    for old in menu.items()? {
        menu.remove(&old)?;
    }
    let none = None::<&str>;
    let (shown, more) = entries(items);
    for e in &shown {
        let approve = MenuItem::with_id(app, format!("approve:{}", e.id), strings.get(if e.fix { "approveFix" } else { "approveReview" }), true, none)?;
        let open = MenuItem::with_id(app, format!("open:{}", e.id), strings.get("openItem"), true, none)?;
        let discard = MenuItem::with_id(app, format!("discard:{}", e.id), strings.get("discard"), true, none)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let parts: [&dyn IsMenuItem<Wry>; 4] = [&approve, &open, &sep, &discard];
        menu.append(&Submenu::with_items(app, &e.label, true, &parts)?)?;
    }
    if !shown.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    if more > 0 {
        menu.append(&MenuItem::with_id(app, "inbox", strings.fill("more", &[("count", &more.to_string())]), true, none)?)?;
    }
    menu.append(&MenuItem::with_id(app, "inbox", strings.get("inboxOpen"), true, none)?)?;
    Ok(())
}

/// A click on an item's command: `approve:r12`, `open:r12` or `discard:r12`. False when the id isn't one of ours.
pub fn on_menu(app: &AppHandle, id: &str) -> bool {
    let Some((action, item)) = id.split_once(':') else { return false };
    if !valid_id(item) {
        return false;
    }
    match action {
        "approve" => confirm(app, item),
        "open" => window::show_hash(app, &format!("inbox?item={item}")),
        "discard" => act(app, item, "discard"),
        _ => return false,
    }
    true
}

/// Approving posts on the host (or pushes): ask first, naming the pull request.
fn confirm(app: &AppHandle, id: &str) {
    let (entry, strings) = {
        let s = crew::shared(app);
        let inner = s.lock();
        (entries(&inner.pending).0.into_iter().find(|e| e.id == id), inner.strings.clone())
    };
    let Some(e) = entry else { return };
    let (question, yes) = if e.fix {
        (strings.fill("confirmFix", &[("pr", &e.pr), ("title", &e.title)]), strings.get("pushReply"))
    } else {
        (strings.fill("confirmReview", &[("pr", &e.pr), ("title", &e.title)]), strings.get("post"))
    };
    let target = app.clone();
    let id = id.to_string();
    app.dialog()
        .message(question)
        .title("Crewreview")
        .buttons(MessageDialogButtons::OkCancelCustom(yes, strings.get("cancel")))
        .show(move |ok| {
            if ok {
                act(&target, &id, "approve");
            }
        });
}

/// Ask the crew to approve or discard, then say how it went and redraw the menu.
fn act(app: &AppHandle, id: &str, what: &'static str) {
    let Some(conn) = crew::shared(app).lock().conn.clone() else { return };
    let app = app.clone();
    let id = id.to_string();
    thread::spawn(move || {
        let (pr, strings) = {
            let s = crew::shared(&app);
            let inner = s.lock();
            let pr = entries(&inner.pending).0.into_iter().find(|e| e.id == id).map(|e| e.pr).unwrap_or_else(|| id.clone());
            (pr, inner.strings.clone())
        };
        let result = conn.post(&format!("/api/inbox/{id}/{what}"));
        if what == "approve" {
            let text = match &result {
                Ok(v) => outcome(v, &pr, &strings),
                Err(e) => strings.fill("failed", &[("pr", &pr), ("error", e)]),
            };
            let _ = app.notification().builder().title("Crewreview").body(text).show();
        }
        crew::refresh_inbox(&app);
    });
}

/// What the crew answered to an approval, in words.
pub fn outcome(v: &Value, pr: &str, strings: &Strings) -> String {
    match v.get("kind").and_then(Value::as_str) {
        Some("posted" | "done" | "pushed") => strings.fill("posted", &[("pr", pr)]),
        Some("stale") => strings.fill("stale", &[("pr", pr)]),
        _ => {
            let error = v.get("error").or_else(|| v.get("kind")).and_then(Value::as_str).unwrap_or("?");
            strings.fill("failed", &[("pr", pr), ("error", error)])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_inbox_ids_are_acted_on() {
        assert!(valid_id("r12") && valid_id("f7"));
        for bad in ["", "r", "x12", "r1/../../api", "r12?x", "12"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn entries_name_the_pull_request_and_stop_at_the_limit() {
        let items: Vec<Value> = (1..=10)
            .map(|n| json!({ "id": format!("r{n}"), "kind": "review", "repo": "acme/shop", "number": 100 + n, "title": "Ship orders with the new carrier API and the rates" }))
            .chain([json!({ "id": "bad", "repo": "x" })])
            .collect();
        let (shown, more) = entries(&items);
        assert_eq!((shown.len(), more), (SHOWN, 2));
        assert_eq!(shown[0].pr, "acme/shop#101");
        assert_eq!(shown[0].label, "acme/shop#101 · Ship orders with the new carrier API…");
        assert!(!shown[0].fix);
        let (fix, _) = entries(&[json!({ "id": "f3", "repo": "acme/api", "number": 86, "title": "Paginate" })]);
        assert!(fix[0].fix);
        assert_eq!(fix[0].label, "acme/api#86 · Paginate");
    }

    #[test]
    fn the_crews_answer_in_words() {
        let s = Strings::default();
        assert_eq!(outcome(&json!({ "kind": "posted" }), "acme/shop#1", &s), "Posted on acme/shop#1.");
        assert!(outcome(&json!({ "kind": "stale" }), "acme/shop#1", &s).starts_with("acme/shop#1 changed"));
        assert!(outcome(&json!({ "kind": "failed", "error": "403" }), "acme/shop#1", &s).contains("403"));
    }
}
