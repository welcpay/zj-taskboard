use crate::platform_daemon;
use std::process::Command;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

const TASKBOARD_URL: &str = "http://127.0.0.1:47823/";

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", url])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("cmd start failed with {status}"));
        }
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let status = Command::new("xdg-open")
            .arg(url)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("xdg-open failed with {status}"));
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Browser fallback is unsupported on this platform".into())
}

fn open_taskboard(app: &AppHandle) -> Result<(), String> {
    platform_daemon::reconcile_daemon(app)?;
    open_browser(TASKBOARD_URL)
}

#[tauri::command]
fn uninstall_daemon(app: AppHandle) -> Result<(), String> {
    platform_daemon::uninstall_daemon(&app)
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            open_taskboard(&app.handle()).map_err(std::io::Error::other)?;
            let open = MenuItem::with_id(app, "open-taskboard", "打开任务面板", true, None::<&str>)?;
            let uninstall = MenuItem::with_id(
                app,
                "stop-and-uninstall-service",
                "停止并卸载本地服务",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &uninstall, &quit])?;
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Codex Taskboard")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open-taskboard" => {
                        let _ = open_taskboard(app);
                    }
                    "stop-and-uninstall-service" => {
                        let _ = platform_daemon::uninstall_daemon(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![uninstall_daemon])
        .build(tauri::generate_context!())
        .expect("failed to build Codex Taskboard");
    app.run(|_, _| {});
}
