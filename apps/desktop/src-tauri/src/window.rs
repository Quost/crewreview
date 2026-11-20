//! The one window: a loading page bundled with the app until the crew is up, then the crew's own dashboard.
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::api::Conn;
use crate::crew;

pub const MAIN: &str = "main";

pub fn create(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    let nav = app.clone();
    let popup = app.clone();
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Crewreview")
        .inner_size(1180.0, 780.0)
        .min_inner_size(420.0, 560.0)
        .visible(visible)
        .on_navigation(move |url| stays_inside(&nav, url))
        .on_new_window(move |url, _features| {
            open_outside(&popup, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// The loading page and the crew's dashboard stay in the window. Anything else (a pull request, the docs) opens in the
/// browser, so the window never shows a page we don't control.
fn stays_inside(app: &AppHandle, url: &Url) -> bool {
    if is_loading_page(url) {
        return true;
    }
    let port = crew::shared(app).lock().conn.as_ref().map(|c| c.port);
    if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && port.is_some() && url.port() == port {
        return true;
    }
    open_outside(app, url);
    false
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn is_loading_page(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn loading_page() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    }
}

pub fn open_dashboard(app: &AppHandle, conn: &Conn, page: Option<&str>) {
    if let (Some(window), Ok(url)) = (app.get_webview_window(MAIN), Url::parse(&conn.dashboard(page))) {
        let _ = window.navigate(url);
    }
}

/// Back to the loading page when the crew went away, so the window never shows a dead dashboard.
pub fn show_loading(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let on_dashboard = window.url().map(|u| !is_loading_page(&u)).unwrap_or(false);
    if on_dashboard {
        if let Ok(url) = Url::parse(loading_page()) {
            let _ = window.navigate(url);
        }
    }
}

/// Bring the window forward on a dashboard address after `#/` (`inbox?item=r12`). Only letters, digits, `?`, `=`.
pub fn show_hash(app: &AppHandle, hash: &str) {
    if !hash.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '?' | '=' | '-' | '_')) {
        return;
    }
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let on_dashboard = window.url().map(|u| u.host_str() == Some("127.0.0.1")).unwrap_or(false);
    if on_dashboard {
        let _ = window.eval(format!("location.hash = '#/{hash}'"));
    }
}

/// Bring the window forward, on a dashboard page if one is given (`inbox`, `now`, …).
pub fn show(app: &AppHandle, page: Option<&'static str>) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(page) = page {
        let on_dashboard = window.url().map(|u| u.host_str() == Some("127.0.0.1")).unwrap_or(false);
        if on_dashboard {
            let _ = window.eval(format!("location.hash = '#/{page}'"));
        }
    }
}
