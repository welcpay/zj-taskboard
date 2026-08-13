import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const prepare = await readFile(new URL("../scripts/prepare-tauri-app.mjs", import.meta.url), "utf8");
const portable = await readFile(new URL("../src-tauri/src/portable.rs", import.meta.url), "utf8");
const daemon = await readFile(new URL("../src-tauri/src/platform_daemon.rs", import.meta.url), "utf8");
const workflow = await readFile(
  new URL("../.github/workflows/package-windows-linux.yml", import.meta.url),
  "utf8",
);

test("Windows and Linux runtime preparation pins native Node archives", () => {
  assert.match(prepare, /x86_64-pc-windows-msvc/);
  assert.match(prepare, /x86_64-unknown-linux-gnu/);
  assert.match(prepare, /node-v22\.23\.2-win-x64\.zip/);
  assert.match(prepare, /node-v22\.23\.2-linux-x64\.tar\.xz/);
  assert.match(prepare, /node-x86_64-pc-windows-msvc\.exe/);
  assert.match(prepare, /node-x86_64-unknown-linux-gnu/);
  assert.match(prepare, /binaryPath:\s*"bin\/node"/);
});

test("the portable launcher uses browser fallback and never owns the HTTP service", () => {
  assert.match(portable, /http:\/\/127\.0\.0\.1:47823\//);
  assert.match(portable, /open_browser/);
  assert.match(portable, /uninstall_daemon/);
  assert.doesNotMatch(portable, /TcpListener/);
});

test("Windows and Linux daemon adapters keep versioned fixed-port services", () => {
  assert.match(daemon, /CodexTaskboard\\Daemon/);
  assert.match(daemon, /schtasks/);
  assert.match(daemon, /codex-taskboard-daemon\.service/);
  assert.match(daemon, /systemctl/);
  assert.match(daemon, /127\.0\.0\.1:47823/);
  assert.match(daemon, /rollback/);
  assert.match(daemon, /current\.json/);
});

test("native package CI builds every requested Windows and Linux installer", () => {
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /ubuntu-24\.04/);
  assert.match(workflow, /bundles:\s*msi,nsis/);
  assert.match(workflow, /bundles:\s*deb,appimage/);
  assert.match(workflow, /steps\.version\.outputs\.version/);
  assert.doesNotMatch(workflow, /codex-taskboard-0\.2\.9-(?:windows|linux)/);
  assert.match(workflow, /bundle\/msi/);
  assert.match(workflow, /bundle\/nsis/);
  assert.match(workflow, /bundle\/deb/);
  assert.match(workflow, /bundle\/appimage/);
});
