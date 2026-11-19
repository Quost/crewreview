// Crewreview desktop: a window and a menu bar (or tray) icon around the crew. The crew itself is the crewreview CLI,
// bundled with the app; apps/desktop/README.md describes how the two talk.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod crew;
mod strings;
mod tray;
mod updates;
mod window;

use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// Passed when the app opens at login: start the crew and the tray, but keep the window closed.
const HIDDEN: &str = "--hidden";

/// For the loading page, while there is no dashboard yet.
#[tauri::command]
fn status(app: AppHandle) -> crew::StatusView {
    crew::shared(&app).lock().status.clone()
}

fn main() {
    let hidden = std::env::args().any(|a| a == HIDDEN);
    let app = tauri::Builder::default()
        // A second launch brings the running app forward instead of starting another crew.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::show(app, None)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![status])
        .setup(move |app| {
            app.manage(Arc::new(crew::Shared::new()));
            window::create(app.handle(), !hidden)?;
            tray::create(app.handle())?;
            crew::start(app.handle().clone());
            updates::schedule(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the crew working; Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Crewreview could not start");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => crew::stop(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => window::show(app, None),
        _ => {}
    });
}
