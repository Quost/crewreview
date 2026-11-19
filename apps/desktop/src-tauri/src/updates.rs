//! Signed updates of the whole app, the bundled crew included. Releases carry a latest.json signed with the same
//! release key as the CLI's SHA256SUMS (the public key is in tauri.conf.json).
use std::thread;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::crew;

/// Look once a while after start, then twice a day, unless `updates.check` is off in the config.
pub fn schedule(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(90));
        loop {
            if crew::shared(&app).lock().update_check {
                check(&app, false);
            }
            thread::sleep(Duration::from_secs(12 * 3600));
        }
    });
}

/// `manual`: from the menu, so say something even when there's nothing new or the check fails.
pub fn check(app: &AppHandle, manual: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let strings = crew::shared(&app).lock().strings.clone();
        let result = match app.updater() {
            Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        match result {
            Ok(Some(update)) => {
                {
                    let s = crew::shared(&app);
                    let mut inner = s.lock();
                    if !manual && inner.offered_update.as_deref() == Some(update.version.as_str()) {
                        return;
                    }
                    inner.offered_update = Some(update.version.clone());
                }
                let question = strings.fill("updateAvailable", &[("version", &update.version)]);
                let target = app.clone();
                app.dialog()
                    .message(question)
                    .title("Crewreview")
                    .buttons(MessageDialogButtons::OkCancelCustom(strings.get("updateInstall"), strings.get("updateLater")))
                    .show(move |yes| {
                        if yes {
                            install(target, update);
                        }
                    });
            }
            Ok(None) if manual => {
                let version = app.package_info().version.to_string();
                app.dialog().message(strings.fill("updateNone", &[("version", &version)])).title("Crewreview").show(|_| {});
            }
            Err(error) if manual => {
                app.dialog().message(strings.fill("updateFailed", &[("error", &error)])).title("Crewreview").show(|_| {});
            }
            _ => {}
        }
    });
}

fn install(app: AppHandle, update: Update) {
    thread::spawn(move || {
        // Stop the crew first: on Windows the installer can't replace a crewreview.exe that is running.
        crew::stop(&app);
        match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
            Ok(()) => app.restart(),
            Err(error) => {
                let strings = crew::shared(&app).lock().strings.clone();
                app.dialog().message(strings.fill("updateFailed", &[("error", &error.to_string())])).title("Crewreview").show(|_| {});
                crew::resume(app);
            }
        }
    });
}
