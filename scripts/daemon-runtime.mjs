import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const DAEMON_LABEL = "com.chuspeeism.codex-taskboard.daemon";
const execFileAsync = promisify(execFile);

export function runtimeLayout(homeDirectory) {
  const supportDirectory = path.join(homeDirectory, "Library", "Application Support", "Codex Taskboard");
  const runtimeDirectory = path.join(supportDirectory, "runtime");
  const logsDirectory = path.join(homeDirectory, "Library", "Logs", "Codex Taskboard");
  return {
    homeDirectory,
    supportDirectory,
    runtimeDirectory,
    currentPath: path.join(runtimeDirectory, "current"),
    daemonMetadataPath: path.join(supportDirectory, "daemon.json"),
    launchAgentsDirectory: path.join(homeDirectory, "Library", "LaunchAgents"),
    launchAgentPath: path.join(homeDirectory, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`),
    logsDirectory,
    stdoutPath: path.join(logsDirectory, "daemon.stdout.log"),
    stderrPath: path.join(logsDirectory, "daemon.stderr.log"),
  };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist(layout) {
  const nodePath = path.join(layout.currentPath, "node");
  const entryPath = path.join(layout.currentPath, "app", "taskboard-daemon.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(entryPath)}</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>47823</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(layout.supportDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xml(layout.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(layout.stderrPath)}</string>
</dict>
</plist>
`;
}

async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function readVerifiedManifest(bundleDirectory) {
  const manifestPath = path.join(bundleDirectory, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("Runtime manifest has an invalid version");
  }
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Runtime manifest has no file checksums");
  }
  for (const [relativePath, checksum] of Object.entries(manifest.files)) {
    if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
      throw new Error(`Runtime manifest contains an unsafe path: ${relativePath}`);
    }
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error(`Runtime manifest contains an invalid checksum: ${relativePath}`);
    }
    const actual = await fileSha256(path.join(bundleDirectory, relativePath));
    if (actual !== checksum) throw new Error(`Runtime checksum mismatch: ${relativePath}`);
  }
  return manifest;
}

async function currentVersion(layout) {
  try {
    return path.basename(await readlink(layout.currentPath));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EINVAL") return null;
    throw error;
  }
}

async function switchCurrent(layout, version) {
  const temporaryLink = path.join(layout.runtimeDirectory, `.current-${process.pid}-${Date.now()}`);
  await symlink(version, temporaryLink);
  await rename(temporaryLink, layout.currentPath);
}

export async function installRuntime({ homeDirectory, bundleDirectory }) {
  const layout = runtimeLayout(homeDirectory);
  const manifest = await readVerifiedManifest(bundleDirectory);
  const previousVersion = await currentVersion(layout);
  const finalDirectory = path.join(layout.runtimeDirectory, manifest.version);
  const stagingDirectory = path.join(
    layout.runtimeDirectory,
    `.staging-${manifest.version}-${process.pid}-${Date.now()}`,
  );
  await mkdir(layout.runtimeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(layout.launchAgentsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(layout.logsDirectory, { recursive: true, mode: 0o700 });
  await rm(stagingDirectory, { recursive: true, force: true });
  await cp(bundleDirectory, stagingDirectory, { recursive: true, force: false });
  await readVerifiedManifest(stagingDirectory);
  await rm(finalDirectory, { recursive: true, force: true });
  await rename(stagingDirectory, finalDirectory);
  await chmod(path.join(finalDirectory, "node"), 0o755);
  await switchCurrent(layout, manifest.version);
  await writeFile(layout.launchAgentPath, renderLaunchAgentPlist(layout), { mode: 0o600 });
  return {
    version: manifest.version,
    previousVersion,
    finalDirectory,
    currentPath: layout.currentPath,
  };
}

export async function rollbackRuntime({ homeDirectory, rollback }) {
  if (!rollback?.previousVersion) throw new Error("No previous runtime is available for rollback");
  const layout = runtimeLayout(homeDirectory);
  await lstat(path.join(layout.runtimeDirectory, rollback.previousVersion));
  await switchCurrent(layout, rollback.previousVersion);
  return { version: rollback.previousVersion };
}

async function defaultRunner(command, args, { allowFailure = false } = {}) {
  try {
    await execFileAsync(command, args);
  } catch (error) {
    if (!allowFailure) throw error;
  }
}

export async function activateRuntime({
  homeDirectory,
  runner = defaultRunner,
  uid = process.getuid(),
}) {
  const layout = runtimeLayout(homeDirectory);
  const domain = `gui/${uid}`;
  const service = `${domain}/${DAEMON_LABEL}`;
  await runner("/bin/launchctl", ["bootout", service], { allowFailure: true });
  await runner("/bin/launchctl", ["bootstrap", domain, layout.launchAgentPath]);
  await runner("/bin/launchctl", ["kickstart", "-k", service]);
}

export async function uninstallRuntime({
  homeDirectory,
  runner = defaultRunner,
  uid = process.getuid(),
}) {
  const layout = runtimeLayout(homeDirectory);
  await runner(
    "/bin/launchctl",
    ["bootout", `gui/${uid}/${DAEMON_LABEL}`],
    { allowFailure: true },
  );
  await rm(layout.launchAgentPath, { force: true });
  await rm(layout.runtimeDirectory, { recursive: true, force: true });
  await rm(layout.daemonMetadataPath, { force: true });
}
