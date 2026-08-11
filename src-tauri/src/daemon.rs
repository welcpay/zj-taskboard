use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const DAEMON_LABEL: &str = "com.chuspeeism.codex-taskboard.daemon";
const HEALTH_ADDRESS: &str = "127.0.0.1:47823";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    version: String,
    files: BTreeMap<String, String>,
}

struct DaemonLayout {
    support: PathBuf,
    runtime: PathBuf,
    current: PathBuf,
    launch_agent: PathBuf,
    logs: PathBuf,
}

fn layout(app: &AppHandle) -> Result<DaemonLayout, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let support = home.join("Library/Application Support/Codex Taskboard");
    let runtime = support.join("runtime");
    Ok(DaemonLayout {
        support,
        current: runtime.join("current"),
        runtime,
        launch_agent: home
            .join("Library/LaunchAgents")
            .join(format!("{DAEMON_LABEL}.plist")),
        logs: home.join("Library/Logs/Codex Taskboard"),
    })
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());
        if entry.file_type().map_err(|error| error.to_string())?.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn sha256(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn verified_manifest(runtime: &Path) -> Result<RuntimeManifest, String> {
    let content = fs::read_to_string(runtime.join("runtime-manifest.json"))
        .map_err(|error| error.to_string())?;
    let manifest: RuntimeManifest = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if manifest.schema_version != 1 || manifest.version.is_empty() || manifest.files.is_empty() {
        return Err("Invalid daemon runtime manifest".into());
    }
    for (relative, expected) in &manifest.files {
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || relative_path.components().any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(format!("Unsafe daemon runtime path: {relative}"));
        }
        let actual = sha256(&runtime.join(relative_path))?;
        if &actual != expected {
            return Err(format!("Daemon runtime checksum mismatch: {relative}"));
        }
    }
    Ok(manifest)
}

fn current_version(layout: &DaemonLayout) -> Option<String> {
    fs::read_link(&layout.current)
        .ok()
        .and_then(|target| target.file_name().map(|value| value.to_string_lossy().into_owned()))
}

fn switch_current(layout: &DaemonLayout, version: &str) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let temporary = layout.runtime.join(format!(".current-{}-{timestamp}", std::process::id()));
    symlink(version, &temporary).map_err(|error| error.to_string())?;
    fs::rename(temporary, &layout.current).map_err(|error| error.to_string())
}

fn launchctl(args: &[&str], allow_failure: bool) -> Result<(), String> {
    let status = Command::new("/bin/launchctl")
        .args(args)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() || allow_failure {
        Ok(())
    } else {
        Err(format!("launchctl {:?} failed with {status}", args))
    }
}

fn service_target() -> String {
    format!("gui/{}/{DAEMON_LABEL}", unsafe { libc::getuid() })
}

fn launch_agent_plist(layout: &DaemonLayout) -> String {
    let node = layout.current.join("node");
    let entry = layout.current.join("app/taskboard-daemon.mjs");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{DAEMON_LABEL}</string>
<key>ProgramArguments</key><array>
<string>{}</string><string>{}</string><string>--host</string><string>127.0.0.1</string><string>--port</string><string>47823</string>
</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>WorkingDirectory</key><string>{}</string>
<key>StandardOutPath</key><string>{}</string>
<key>StandardErrorPath</key><string>{}</string>
</dict></plist>
"#,
        node.display(),
        entry.display(),
        layout.support.display(),
        layout.logs.join("daemon.stdout.log").display(),
        layout.logs.join("daemon.stderr.log").display(),
    )
}

fn restart_launch_agent(layout: &DaemonLayout) -> Result<(), String> {
    let service = service_target();
    launchctl(&["bootout", &service], true)?;
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    launchctl(
        &["bootstrap", &domain, &layout.launch_agent.to_string_lossy()],
        false,
    )?;
    launchctl(&["kickstart", "-k", &service], false)
}

fn health_version() -> Result<String, String> {
    let address = HEALTH_ADDRESS
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| "Cannot resolve daemon health address".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:47823\r\nConnection: close\r\n\r\n")
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|error| error.to_string())?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .ok_or_else(|| "Daemon health returned an invalid HTTP response".to_string())?;
    let value: serde_json::Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
    if value.get("product").and_then(|value| value.as_str()) != Some("codex-taskboard") {
        return Err(format!("Unknown process owns {HEALTH_ADDRESS}"));
    }
    value
        .get("daemonVersion")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "Daemon health omitted daemonVersion".to_string())
}

fn wait_for_health(expected_version: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last_error = "Daemon health check did not run".to_string();
    while Instant::now() < deadline {
        match health_version() {
            Ok(version) if version == expected_version => return Ok(()),
            Ok(version) => last_error = format!("Expected daemon {expected_version}, got {version}"),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(last_error)
}

pub fn reconcile_daemon(app: &AppHandle) -> Result<String, String> {
    let layout = layout(app)?;
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("daemon-runtime");
    let manifest = verified_manifest(&bundled)?;
    let previous = current_version(&layout);
    let final_runtime = layout.runtime.join(&manifest.version);
    let staging = layout.runtime.join(format!(
        ".staging-{}-{}",
        manifest.version,
        std::process::id()
    ));
    fs::create_dir_all(&layout.runtime).map_err(|error| error.to_string())?;
    fs::create_dir_all(layout.launch_agent.parent().unwrap()).map_err(|error| error.to_string())?;
    fs::create_dir_all(&layout.logs).map_err(|error| error.to_string())?;
    let _ = fs::remove_dir_all(&staging);
    copy_directory(&bundled, &staging)?;
    verified_manifest(&staging)?;
    let _ = fs::remove_dir_all(&final_runtime);
    fs::rename(&staging, &final_runtime).map_err(|error| error.to_string())?;
    switch_current(&layout, &manifest.version)?;
    fs::write(&layout.launch_agent, launch_agent_plist(&layout)).map_err(|error| error.to_string())?;

    let activation = restart_launch_agent(&layout).and_then(|_| wait_for_health(&manifest.version));
    if let Err(error) = activation {
        if let Some(previous_version) = previous.as_deref() {
            switch_current(&layout, previous_version)?;
            let _ = restart_launch_agent(&layout);
            let _ = wait_for_health(previous_version);
        }
        return Err(format!("Daemon update failed and rollback was attempted: {error}"));
    }

    for entry in fs::read_dir(&layout.runtime).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != manifest.version && previous.as_deref() != Some(name.as_str()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(manifest.version)
}

#[tauri::command]
pub fn uninstall_daemon(app: AppHandle) -> Result<(), String> {
    let layout = layout(&app)?;
    launchctl(&["bootout", &service_target()], true)?;
    let _ = fs::remove_file(&layout.launch_agent);
    let _ = fs::remove_dir_all(&layout.runtime);
    let _ = fs::remove_file(layout.support.join("daemon.json"));
    Ok(())
}
