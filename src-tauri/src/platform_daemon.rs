use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const HEALTH_ADDRESS: &str = "127.0.0.1:47823";
const WINDOWS_TASK_NAME: &str = r"CodexTaskboard\Daemon";
const LINUX_UNIT_NAME: &str = "codex-taskboard-daemon.service";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    version: String,
    files: BTreeMap<String, String>,
}

struct Layout {
    support: PathBuf,
    runtime: PathBuf,
    current_json: PathBuf,
    service_definition: PathBuf,
    logs: PathBuf,
}

fn support_directory(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|base| base.join("Codex Taskboard"))
            .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        let base = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"));
        return Ok(base.join("Codex Taskboard"));
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform".into())
}

fn layout(app: &AppHandle) -> Result<Layout, String> {
    let support = support_directory(app)?;
    #[cfg(target_os = "windows")]
    let service_definition = support.join("daemon-task.xml");
    #[cfg(target_os = "linux")]
    let service_definition = app
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?
        .join(".config/systemd/user")
        .join(LINUX_UNIT_NAME);
    Ok(Layout {
        runtime: support.join("runtime"),
        current_json: support.join("runtime/current.json"),
        logs: support.join("logs"),
        support,
        service_definition,
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
    Ok(format!("{:x}", Sha256::digest(fs::read(path).map_err(|error| error.to_string())?)))
}

fn verified_manifest(runtime: &Path) -> Result<RuntimeManifest, String> {
    let content = fs::read_to_string(runtime.join("runtime-manifest.json"))
        .map_err(|error| error.to_string())?;
    let manifest: RuntimeManifest =
        serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if manifest.schema_version != 1 || manifest.version.is_empty() || manifest.files.is_empty() {
        return Err("Invalid daemon runtime manifest".into());
    }
    for (relative, expected) in &manifest.files {
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(format!("Unsafe daemon runtime path: {relative}"));
        }
        if sha256(&runtime.join(relative_path))? != *expected {
            return Err(format!("Daemon runtime checksum mismatch: {relative}"));
        }
    }
    Ok(manifest)
}

fn current_version(layout: &Layout) -> Result<Option<String>, String> {
    let content = match fs::read_to_string(&layout.current_json) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let record: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| error.to_string())?;
    Ok(record
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::to_owned))
}

fn write_current(layout: &Layout, version: &str) -> Result<(), String> {
    let temporary = layout
        .runtime
        .join(format!(".current-{}-{}.json", std::process::id(), version));
    fs::write(
        &temporary,
        serde_json::json!({ "version": version }).to_string(),
    )
    .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&layout.current_json);
    fs::rename(temporary, &layout.current_json).map_err(|error| error.to_string())
}

fn runtime_node(runtime: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return runtime.join("node.exe");
    }
    #[cfg(target_os = "linux")]
    {
        return runtime.join("node");
    }
    #[allow(unreachable_code)]
    runtime.join("node")
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn systemd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn service_definition(layout: &Layout, version: &str) -> Result<String, String> {
    let runtime = layout.runtime.join(version);
    let node = runtime_node(&runtime);
    let entry = runtime.join("app/taskboard-daemon.mjs");
    #[cfg(target_os = "windows")]
    {
        let arguments = format!(
            "\"{}\" --host 127.0.0.1 --port 47823",
            entry.display()
        );
        return Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>{}</Command><Arguments>{}</Arguments><WorkingDirectory>{}</WorkingDirectory></Exec></Actions>
</Task>"#,
            xml(&node.display().to_string()),
            xml(&arguments),
            xml(&layout.support.display().to_string()),
        ));
    }
    #[cfg(target_os = "linux")]
    {
        return Ok(format!(
            "[Unit]\nDescription=Codex Taskboard local daemon\nAfter=default.target\n\n[Service]\nType=simple\nExecStart={} {} --host 127.0.0.1 --port 47823\nWorkingDirectory={}\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n",
            systemd_quote(&node.display().to_string()),
            systemd_quote(&entry.display().to_string()),
            systemd_quote(&layout.support.display().to_string()),
        ));
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform".into())
}

fn run(command: &str, args: &[&str], allow_failure: bool) -> Result<(), String> {
    let status = Command::new(command)
        .args(args)
        .status()
        .map_err(|error| format!("{command} failed to start: {error}"))?;
    if status.success() || allow_failure {
        Ok(())
    } else {
        Err(format!("{command} {:?} failed with {status}", args))
    }
}

fn stop_service() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return run("schtasks", &["/End", "/TN", WINDOWS_TASK_NAME], true);
    }
    #[cfg(target_os = "linux")]
    {
        return run(
            "systemctl",
            &["--user", "disable", "--now", LINUX_UNIT_NAME],
            true,
        );
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform".into())
}

fn write_service_definition(layout: &Layout, version: &str) -> Result<(), String> {
    let content = service_definition(layout, version)?;
    if let Some(parent) = layout.service_definition.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&layout.service_definition, content).map_err(|error| error.to_string())
}

fn activate_service(layout: &Layout) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let definition = layout
            .service_definition
            .to_str()
            .ok_or_else(|| "Task Scheduler definition path is not UTF-8".to_string())?;
        run(
            "schtasks",
            &["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", definition, "/F"],
            false,
        )?;
        return run("schtasks", &["/Run", "/TN", WINDOWS_TASK_NAME], false);
    }
    #[cfg(target_os = "linux")]
    {
        run("systemctl", &["--user", "daemon-reload"], false)?;
        return run(
            "systemctl",
            &["--user", "enable", "--now", LINUX_UNIT_NAME],
            false,
        );
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform".into())
}

fn health_version() -> Result<String, String> {
    let address = HEALTH_ADDRESS
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| "Daemon health address did not resolve".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .ok_or_else(|| "Daemon health returned an invalid HTTP response".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|error| error.to_string())?;
    if value.get("product").and_then(|value| value.as_str()) != Some("codex-taskboard") {
        return Err(format!("Unknown process owns {HEALTH_ADDRESS}"));
    }
    value
        .get("daemonVersion")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "Daemon health omitted daemonVersion".to_string())
}

fn wait_for_health(expected: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last_error = "Daemon health check did not run".to_string();
    while Instant::now() < deadline {
        match health_version() {
            Ok(version) if version == expected => return Ok(()),
            Ok(version) => last_error = format!("Expected daemon {expected}, got {version}"),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(last_error)
}

fn rollback(layout: &Layout, previous: &str) -> Result<(), String> {
    stop_service()?;
    write_current(layout, previous)?;
    write_service_definition(layout, previous)?;
    activate_service(layout)
}

pub fn reconcile_daemon(app: &AppHandle) -> Result<String, String> {
    let layout = layout(app)?;
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("daemon-runtime");
    let manifest = verified_manifest(&bundled)?;
    let previous = current_version(&layout)?;
    let final_runtime = layout.runtime.join(&manifest.version);

    if previous.as_deref() == Some(manifest.version.as_str()) && final_runtime.is_dir() {
        write_service_definition(&layout, &manifest.version)?;
        activate_service(&layout)?;
        wait_for_health(&manifest.version)?;
        return Ok(manifest.version);
    }

    fs::create_dir_all(&layout.runtime).map_err(|error| error.to_string())?;
    fs::create_dir_all(&layout.logs).map_err(|error| error.to_string())?;
    stop_service()?;
    let staging = layout
        .runtime
        .join(format!(".staging-{}-{}", manifest.version, std::process::id()));
    let installation = (|| {
        let _ = fs::remove_dir_all(&staging);
        copy_directory(&bundled, &staging)?;
        verified_manifest(&staging)?;
        let _ = fs::remove_dir_all(&final_runtime);
        fs::rename(&staging, &final_runtime).map_err(|error| error.to_string())?;
        write_current(&layout, &manifest.version)?;
        write_service_definition(&layout, &manifest.version)?;
        activate_service(&layout)?;
        wait_for_health(&manifest.version)
    })();

    if let Err(error) = installation {
        let _ = fs::remove_dir_all(&staging);
        if let Some(previous) = previous.as_deref() {
            let _ = rollback(&layout, previous);
        }
        return Err(format!("Daemon update failed and rollback was attempted: {error}"));
    }
    Ok(manifest.version)
}

pub fn uninstall_daemon(app: &AppHandle) -> Result<(), String> {
    let layout = layout(app)?;
    stop_service()?;
    #[cfg(target_os = "windows")]
    {
        run("schtasks", &["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], true)?;
    }
    #[cfg(target_os = "linux")]
    {
        run("systemctl", &["--user", "daemon-reload"], true)?;
    }
    let _ = fs::remove_file(&layout.service_definition);
    let _ = fs::remove_dir_all(&layout.runtime);
    Ok(())
}
