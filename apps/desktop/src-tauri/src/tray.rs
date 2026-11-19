//! The menu bar (macOS) or tray (Windows, Linux) icon: the crew's state, the inbox count, and the app's commands.
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::crew;
use crate::strings::Strings;
use crate::{updates, window};

const TRAY: &str = "crew";

struct Items {
    status: MenuItem<Wry>,
    open: MenuItem<Wry>,
    inbox: MenuItem<Wry>,
    check: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    updates: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let s = Strings::default();
    let none = None::<&str>;
    let items = Items {
        status: MenuItem::with_id(app, "status", s.get("starting"), false, none)?,
        open: MenuItem::with_id(app, "open", s.get("open"), true, none)?,
        inbox: MenuItem::with_id(app, "inbox", s.fill("inbox", &[("count", "0")]), false, none)?,
        check: MenuItem::with_id(app, "check", s.get("checkNow"), false, none)?,
        autostart: CheckMenuItem::with_id(app, "autostart", s.get("autostart"), true, autostart_on(app), none)?,
        updates: MenuItem::with_id(app, "updates", s.get("updates"), true, none)?,
        quit: MenuItem::with_id(app, "quit", s.get("quit"), true, none)?,
    };
    let menu = Menu::with_items(
        app,
        &[
            &items.status,
            &PredefinedMenuItem::separator(app)?,
            &items.open,
            &items.inbox,
            &items.check,
            &PredefinedMenuItem::separator(app)?,
            &items.autostart,
            &items.updates,
            &PredefinedMenuItem::separator(app)?,
            &items.quit,
        ],
    )?;
    let builder = TrayIconBuilder::with_id(TRAY).menu(&menu).tooltip("Crewreview").on_menu_event(on_menu);
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let builder = {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        let builder = match app.default_window_icon() {
            Some(icon) => builder.icon(icon.clone()),
            None => builder,
        };
        // Windows: a left click opens the window, a right click the menu (Linux trays only have the menu).
        builder.show_menu_on_left_click(false).on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                window::show(tray.app_handle(), None);
            }
        })
    };
    builder.build(app)?;
    app.manage(items);
    Ok(())
}

fn autostart_on(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => window::show(app, None),
        "inbox" => window::show(app, Some("inbox")),
        "check" => {
            if let Some(conn) = crew::shared(app).lock().conn.clone() {
                std::thread::spawn(move || {
                    let _ = conn.post("/api/cycle");
                });
            }
        }
        "autostart" => {
            let launcher = app.autolaunch();
            let _ = if autostart_on(app) { launcher.disable() } else { launcher.enable() };
            refresh(app);
        }
        "updates" => updates::check(app, true),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Redraw texts and counts from the shared state (call it after anything there changed).
pub fn refresh(app: &AppHandle) {
    let (strings, conn, inbox) = {
        let s = crew::shared(app);
        let inner = s.lock();
        (inner.strings.clone(), inner.conn.clone(), inner.inbox)
    };
    let Some(items) = app.try_state::<Items>() else { return };
    let status = match &conn {
        Some(c) if c.managed => strings.fill("running", &[("version", &c.version)]),
        Some(c) => strings.fill("attached", &[("version", &c.version)]),
        None => strings.get("starting"),
    };
    let inbox_text = strings.fill("inbox", &[("count", &inbox.to_string())]);
    let _ = items.status.set_text(&status);
    let _ = items.open.set_text(strings.get("open"));
    let _ = items.inbox.set_text(&inbox_text);
    let _ = items.inbox.set_enabled(conn.is_some());
    let _ = items.check.set_text(strings.get("checkNow"));
    let _ = items.check.set_enabled(conn.is_some());
    let _ = items.autostart.set_text(strings.get("autostart"));
    let _ = items.autostart.set_checked(autostart_on(app));
    let _ = items.updates.set_text(strings.get("updates"));
    let _ = items.quit.set_text(strings.get("quit"));
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_tooltip(Some(format!("Crewreview · {status} · {inbox_text}")));
        // Next to the menu bar icon, the number of items waiting for approval (nothing when there are none).
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(if inbox > 0 { Some(inbox.to_string()) } else { None });
    }
}
