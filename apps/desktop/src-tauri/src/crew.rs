//! Keeps the crew running. It starts the bundled `crewreview run --desktop`, or uses a crew that already runs (the
//! background service), restarts it when it stops, and watches it for the tray and the notifications.
//!
//! Lock discipline: never call into a window, the tray or a dialog while holding `Shared`'s lock. Those calls run on
//! the main thread, which may itself be waiting for the lock (the navigation check reads it).
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::api::Conn;
use crate::strings::Strings;
use crate::{tray, window};

/// What the loading page shows while there is no dashboard.
#[derive(Clone, Default, Serialize)]
pub struct StatusView {
    pub text: String,
    pub detail: String,
    pub error: bool,
}

pub struct Inner {
    pub strings: Strings,
    pub conn: Option<Conn>,
    pub status: StatusView,
    pub inbox: u64,
    /// What waits in the inbox, as the API lists it, for the menu.
    pub pending: Vec<Value>,
    /// `updates.check` from the user's config.
    pub update_check: bool,
    /// The release we already asked about, so the daily check doesn't ask twice.
    pub offered_update: Option<String>,
    child: Option<Child>,
    seen: HashSet<String>,
    seeded: bool,
    stopping: bool,
}

pub struct Shared(Mutex<Inner>);

impl Shared {
    pub fn new() -> Shared {
        Shared(Mutex::new(Inner {
            strings: Strings::default(),
            conn: None,
            status: StatusView::default(),
            inbox: 0,
            pending: Vec::new(),
            update_check: true,
            offered_update: None,
            child: None,
            seen: HashSet::new(),
            seeded: false,
            stopping: false,
        }))
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn shared(app: &AppHandle) -> Arc<Shared> {
    app.state::<Arc<Shared>>().inner().clone()
}

pub fn start(app: AppHandle) {
    let watcher = app.clone();
    thread::spawn(move || supervise(app));
    thread::spawn(move || watch(watcher));
}

/// Start the crew again after `stop` (an update that failed to install).
pub fn resume(app: AppHandle) {
    shared(&app).lock().stopping = false;
    thread::spawn(move || supervise(app));
}

/// Tell the crew this app started one thing, as a JSON line on its stdin. Nothing when it isn't ours or has stopped.
pub fn tell(app: &AppHandle, msg: &Value) {
    let s = shared(app);
    let mut inner = s.lock();
    if let Some(stdin) = inner.child.as_mut().and_then(|c| c.stdin.as_mut()) {
        let _ = writeln!(stdin, "{msg}").and_then(|_| stdin.flush());
    }
}

/// Stop the crew this app started. It stops when its stdin closes; a review in progress gets a few seconds, then it
/// is killed, and the crew picks the review up again next time.
pub fn stop(app: &AppHandle) {
    let s = shared(app);
    let child = {
        let mut inner = s.lock();
        inner.stopping = true;
        inner.child.take()
    };
    if let Some(mut child) = child {
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn supervise(app: AppHandle) {
    let s = shared(&app);
    let mut wait = Duration::from_secs(2);
    loop {
        if s.lock().stopping {
            return;
        }
        let began = Instant::now();
        match run_crew(&app) {
            Ok(Some(conn)) => follow(&app, &conn),
            Ok(None) => {}
            Err(detail) => {
                let text = s.lock().strings.get("startFailed");
                set_status(&app, text, detail, true);
            }
        }
        {
            let mut inner = s.lock();
            if inner.stopping {
                return;
            }
            inner.conn = None;
        }
        tray::refresh(&app);
        window::show_loading(&app);
        // A crew that ran for a while restarts at once; one that keeps failing is retried less and less often.
        if began.elapsed() > Duration::from_secs(60) {
            wait = Duration::from_secs(2);
        }
        thread::sleep(wait);
        wait = (wait * 2).min(Duration::from_secs(60));
    }
}

/// Run `crewreview run --desktop` until it stops. `Ok(Some(conn))` when it found a crew already running and we should
/// follow that one; `Ok(None)` when it stopped because we asked; `Err` with what went wrong otherwise.
fn run_crew(app: &AppHandle) -> Result<Option<Conn>, String> {
    let s = shared(app);
    let starting = s.lock().strings.get("starting");
    set_status(app, starting, String::new(), false);

    let log = log_file(app);
    let mut cmd = Command::new(sidecar()?);
    cmd.args(["run", "--desktop"])
        .env("CREWREVIEW_DESKTOP", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log.as_ref().and_then(|p| File::create(p).ok()).map(Stdio::from).unwrap_or_else(Stdio::null));
    // Apps opened from the Finder or the Start menu get no LANG: pass the system language along.
    if std::env::var_os("CREWREVIEW_LANG").is_none() {
        if let Some(locale) = sys_locale::get_locale() {
            cmd.env("CREWREVIEW_LANG", locale);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("the crew has no stdout")?;
    // The crew runs as long as its stdin stays open; keep the child where `stop` can reach it.
    s.lock().child = Some(child);
    // What the dashboard shows about the app itself, and changes through the crew.
    tray::tell_autostart(app);

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(strings) = msg.get("strings").and_then(Value::as_object) {
            let text = {
                let mut inner = s.lock();
                inner.strings.merge(strings);
                inner.update_check = msg.get("updateCheck").and_then(Value::as_bool).unwrap_or(true);
                inner.strings.get("starting")
            };
            set_status(app, text, String::new(), false);
            tray::refresh(app);
        } else if let Some(info) = msg.get("ready") {
            connected(app, Conn::from_info(info, true).ok_or("the crew sent an unreadable address")?);
        } else if let Some(info) = msg.get("attach") {
            reap(&s);
            let conn = Conn::from_info(info, false).ok_or("the crew sent an unreadable address")?;
            connected(app, conn.clone());
            return Ok(Some(conn));
        } else if let Some(on) = msg.get("autostart").and_then(Value::as_bool) {
            // The dashboard asked to open (or not) at login.
            tray::set_autostart(app, on);
        } else if let Some(error) = msg.get("error").and_then(Value::as_str) {
            reap(&s);
            return Err(error.to_string());
        }
    }
    let code = reap(&s);
    if s.lock().stopping {
        return Ok(None);
    }
    let tail = log.and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default();
    let tail: Vec<&str> = tail.lines().rev().take(12).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    Err(format!("exit {}\n{}", code.map_or("?".to_string(), |c| c.to_string()), tail.join("\n")))
}

/// Wait for the crew process we started, if it's still ours to wait for.
fn reap(s: &Shared) -> Option<i32> {
    let child = s.lock().child.take();
    child.and_then(|mut c| c.wait().ok()).and_then(|status| status.code())
}

/// Stay with a crew that something else started until it goes away (the service stopped), then start our own.
fn follow(app: &AppHandle, conn: &Conn) {
    let s = shared(app);
    let mut misses = 0;
    loop {
        thread::sleep(Duration::from_secs(5));
        if s.lock().stopping {
            return;
        }
        if conn.get("/api/state").is_ok() {
            misses = 0;
        } else {
            misses += 1;
            if misses >= 2 {
                return;
            }
        }
    }
}

fn connected(app: &AppHandle, conn: Conn) {
    {
        let s = shared(app);
        let mut inner = s.lock();
        inner.conn = Some(conn.clone());
        inner.status = StatusView::default();
    }
    window::open_dashboard(app, &conn, None);
    tray::refresh(app);
}

fn set_status(app: &AppHandle, text: String, detail: String, error: bool) {
    shared(app).lock().status = StatusView { text, detail, error };
}

/// Every few seconds: the inbox count for the tray, and a notification for each new item waiting for approval.
fn watch(app: AppHandle) {
    let s = shared(&app);
    let mut tick: u64 = 0;
    loop {
        thread::sleep(Duration::from_secs(3));
        let conn = {
            let inner = s.lock();
            if inner.stopping {
                continue;
            }
            inner.conn.clone()
        };
        let Some(conn) = conn else { continue };
        let Ok(state) = conn.get("/api/state") else { continue };
        let inbox = state.pointer("/status/inbox").and_then(Value::as_u64).unwrap_or(0);
        let (changed, seeded) = {
            let mut inner = s.lock();
            let changed = inner.inbox != inbox;
            inner.inbox = inbox;
            (changed, inner.seeded)
        };
        if changed {
            tray::refresh(&app);
        }
        tick += 1;
        // The list too, for the menu: when the count moved, and now and then (an item can replace another).
        if changed || !seeded || tick.is_multiple_of(10) {
            if let Ok(items) = conn.get("/api/inbox") {
                notify_new(&app, &items);
                keep_pending(&app, items);
            }
        }
    }
}

/// Remember the inbox items and redraw the menu.
fn keep_pending(app: &AppHandle, items: Value) {
    let list = items.as_array().cloned().unwrap_or_default();
    shared(app).lock().pending = list;
    tray::refresh(app);
}

/// Read the inbox again now: after an approval or a discard from the menu.
pub fn refresh_inbox(app: &AppHandle) {
    let Some(conn) = shared(app).lock().conn.clone() else { return };
    if let Ok(items) = conn.get("/api/inbox") {
        let count = items.as_array().map(|a| a.len() as u64).unwrap_or(0);
        shared(app).lock().inbox = count;
        keep_pending(app, items);
    }
}

fn notify_new(app: &AppHandle, items: &Value) {
    let Some(items) = items.as_array() else { return };
    let s = shared(app);
    let (fresh, strings) = {
        let mut inner = s.lock();
        // What is already waiting when the app starts doesn't pop up; only what arrives afterwards.
        let first = !inner.seeded;
        inner.seeded = true;
        let mut fresh = Vec::new();
        for item in items {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                if inner.seen.insert(id.to_string()) && !first {
                    fresh.push(item.clone());
                }
            }
        }
        (fresh, inner.strings.clone())
    };
    for item in fresh.iter().take(3) {
        let repo = item.get("repo").and_then(Value::as_str).unwrap_or("");
        let number = item.get("number").map(|n| n.to_string()).unwrap_or_default();
        let title = item.get("title").and_then(Value::as_str).unwrap_or("");
        let key = if item.get("kind").and_then(Value::as_str) == Some("fix") { "notifyFix" } else { "notifyReview" };
        let _ = app
            .notification()
            .builder()
            .title(format!("{repo} #{number}"))
            .body(strings.fill(key, &[("title", title)]))
            .show();
    }
}

/// The CLI the app runs.
fn sidecar() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("the app has no folder")?;
    Ok(sidecar_in(dir, Path::is_file))
}

/// Tauri bundles the CLI next to the app's executable and strips the target triple. The Linux packages carry it in
/// `../libexec/crewreview` instead: linuxdeploy rewrites every binary under `usr/bin` and `usr/lib` of an AppImage,
/// and a Bun-compiled binary doesn't survive that.
fn sidecar_in(dir: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let packaged = dir.join("../libexec/crewreview/crewreview");
    if exists(&packaged) {
        return packaged;
    }
    dir.join(if cfg!(windows) { "crewreview.exe" } else { "crewreview" })
}

/// The crew's stderr goes to crew.log in the app's log folder, replaced at each start.
fn log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("crew.log"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_sits_next_to_the_app_unless_a_linux_package_put_it_in_libexec() {
        let bin = Path::new("/usr/bin");
        let next = bin.join(if cfg!(windows) { "crewreview.exe" } else { "crewreview" });
        assert_eq!(sidecar_in(bin, |_| false), next);
        let packaged = bin.join("../libexec/crewreview/crewreview");
        assert_eq!(sidecar_in(bin, |p| p == packaged), packaged);
    }
}
