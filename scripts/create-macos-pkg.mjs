#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_LABEL = "com.chuspeeism.codex-taskboard.daemon";
const APP_NAME = "Codex Taskboard.app";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
  }
}

export function preinstallScript() {
  return `#!/bin/sh
set -eu
console_user="$(/usr/bin/stat -f '%Su' /dev/console)"
if [ -n "$console_user" ] && [ "$console_user" != "root" ]; then
  uid="$(/usr/bin/id -u "$console_user")"
  /bin/launchctl bootout "gui/$uid/${DAEMON_LABEL}" 2>/dev/null || true
fi
exit 0
`;
}

export function postinstallScript(version) {
  return `#!/bin/sh
set -eu
console_user="$(/usr/bin/stat -f '%Su' /dev/console)"
if [ -z "$console_user" ] || [ "$console_user" = "root" ] || [ "$console_user" = "loginwindow" ]; then
  echo "Codex Taskboard requires a logged-in user to reconcile its local service." >&2
  exit 1
fi

uid="$(/usr/bin/id -u "$console_user")"
if ! /bin/launchctl asuser "$uid" /usr/bin/sudo -u "$console_user" /usr/bin/open -a "/Applications/Codex Taskboard.app"; then
  echo "Failed to launch Codex Taskboard for service reconciliation." >&2
  exit 1
fi

attempt=0
while [ "$attempt" -lt 60 ]; do
  health="$(/usr/bin/curl --silent --show-error --max-time 2 http://127.0.0.1:47823/health 2>/dev/null || true)"
  compact_health="$(printf '%s' "$health" | /usr/bin/tr -d '[:space:]')"
  if printf '%s' "$compact_health" | /usr/bin/grep -Fq '"product":"codex-taskboard"' && \
     printf '%s' "$compact_health" | /usr/bin/grep -Fq '"daemonVersion":"${version}"'; then
    exit 0
  fi
  attempt=$((attempt + 1))
  /bin/sleep 1
done

echo "Codex Taskboard daemon did not become healthy at version ${version}." >&2
exit 1
`;
}

export async function createMacosPkg({ appPath, outputPath, version, runCommand = run }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid PKG version: ${version}`);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-pkg."));
  try {
    const payloadRoot = path.join(temporaryRoot, "payload");
    const scriptsRoot = path.join(temporaryRoot, "scripts");
    const componentPath = path.join(temporaryRoot, "CodexTaskboard-component.pkg");
    await mkdir(path.join(payloadRoot, "Applications"), { recursive: true });
    await mkdir(scriptsRoot, { recursive: true });
    await cp(appPath, path.join(payloadRoot, "Applications", APP_NAME), { recursive: true });
    await writeFile(path.join(scriptsRoot, "preinstall"), preinstallScript(), { mode: 0o755 });
    await writeFile(path.join(scriptsRoot, "postinstall"), postinstallScript(version), { mode: 0o755 });
    await mkdir(path.dirname(outputPath), { recursive: true });
    runCommand("/usr/bin/pkgbuild", [
      "--root", payloadRoot,
      "--scripts", scriptsRoot,
      "--identifier", "com.chuspeeism.codex-taskboard.pkg",
      "--version", version,
      "--install-location", "/",
      componentPath,
    ]);
    runCommand("/usr/bin/productbuild", ["--package", componentPath, outputPath]);
    return outputPath;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const version = process.argv[4]?.trim();
  if (!appPath || !outputPath || !version) {
    throw new Error("Usage: create-macos-pkg.mjs <App.app> <output.pkg> <version>");
  }
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (packageJson.version !== version) throw new Error("PKG version does not match package.json");
  await createMacosPkg({ appPath, outputPath, version });
  console.log(`Created ${outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
