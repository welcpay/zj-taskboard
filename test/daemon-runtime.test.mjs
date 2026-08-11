import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  activateRuntime,
  installRuntime,
  renderLaunchAgentPlist,
  rollbackRuntime,
  runtimeLayout,
  uninstallRuntime,
} from "../scripts/daemon-runtime.mjs";

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function createRuntimeBundle(root, version) {
  const bundle = path.join(root, `bundle-${version}`);
  await mkdir(path.join(bundle, "app", "server"), { recursive: true });
  await writeFile(path.join(bundle, "node"), "node-runtime");
  await chmod(path.join(bundle, "node"), 0o755);
  await writeFile(path.join(bundle, "app", "taskboard-daemon.mjs"), "daemon-entry");
  await writeFile(path.join(bundle, "app", "server", "index.mjs"), "server-entry");
  const files = {};
  for (const relativePath of ["node", "app/taskboard-daemon.mjs", "app/server/index.mjs"]) {
    files[relativePath] = await sha256(path.join(bundle, relativePath));
  }
  await writeFile(
    path.join(bundle, "runtime-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, version, files }, null, 2)}\n`,
  );
  return bundle;
}

test("a verified runtime installs atomically and can roll back", async (t) => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-daemon-home-"));
  const bundlesDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-daemon-bundles-"));
  t.after(() => Promise.all([
    rm(homeDirectory, { recursive: true, force: true }),
    rm(bundlesDirectory, { recursive: true, force: true }),
  ]));

  const firstBundle = await createRuntimeBundle(bundlesDirectory, "0.3.0");
  const first = await installRuntime({ homeDirectory, bundleDirectory: firstBundle });
  const layout = runtimeLayout(homeDirectory);

  assert.equal(first.version, "0.3.0");
  assert.equal(first.previousVersion, null);
  assert.equal(await readlink(layout.currentPath), "0.3.0");
  assert.equal((await lstat(layout.currentPath)).isSymbolicLink(), true);
  assert.match(await readFile(layout.launchAgentPath, "utf8"), /com\.chuspeeism\.codex-taskboard\.daemon/);
  assert.match(await readFile(layout.launchAgentPath, "utf8"), /<string>127\.0\.0\.1<\/string>/);
  assert.match(await readFile(layout.launchAgentPath, "utf8"), /<string>47823<\/string>/);

  const secondBundle = await createRuntimeBundle(bundlesDirectory, "0.3.1");
  const second = await installRuntime({ homeDirectory, bundleDirectory: secondBundle });
  assert.equal(second.previousVersion, "0.3.0");
  assert.equal(await readlink(layout.currentPath), "0.3.1");

  await rollbackRuntime({ homeDirectory, rollback: second });
  assert.equal(await readlink(layout.currentPath), "0.3.0");
});

test("activation uses launchctl argument arrays and uninstall preserves data", async (t) => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-daemon-home-"));
  const bundleDirectory = await createRuntimeBundle(homeDirectory, "0.3.2");
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  await installRuntime({ homeDirectory, bundleDirectory });
  const calls = [];
  const runner = async (command, args) => calls.push([command, args]);

  await activateRuntime({ homeDirectory, runner, uid: 501 });
  assert.deepEqual(calls, [
    ["/bin/launchctl", ["bootout", "gui/501/com.chuspeeism.codex-taskboard.daemon"]],
    ["/bin/launchctl", ["bootstrap", "gui/501", runtimeLayout(homeDirectory).launchAgentPath]],
    ["/bin/launchctl", ["kickstart", "-k", "gui/501/com.chuspeeism.codex-taskboard.daemon"]],
  ]);

  const dataFile = path.join(runtimeLayout(homeDirectory).supportDirectory, "taskboard.sqlite");
  await writeFile(dataFile, "keep-me");
  await uninstallRuntime({ homeDirectory, runner, uid: 501 });
  await assert.rejects(lstat(runtimeLayout(homeDirectory).runtimeDirectory), { code: "ENOENT" });
  await assert.rejects(lstat(runtimeLayout(homeDirectory).launchAgentPath), { code: "ENOENT" });
  assert.equal(await readFile(dataFile, "utf8"), "keep-me");
});

test("the launch agent is persistent and throttled", () => {
  const plist = renderLaunchAgentPlist(runtimeLayout("/Users/example"));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /Library\/Logs\/Codex Taskboard\/daemon\.stdout\.log/);
  assert.match(plist, /runtime\/current\/node/);
});

test("the Tauri preparation step packages a self-contained daemon runtime", async () => {
  const prepareSource = await readFile(
    new URL("../scripts/prepare-tauri-app.mjs", import.meta.url),
    "utf8",
  );
  const daemonSource = await readFile(
    new URL("../scripts/taskboard-daemon.mjs", import.meta.url),
    "utf8",
  );
  assert.match(prepareSource, /resourcesDirectory, "daemon-runtime"/);
  assert.match(prepareSource, /runtime-manifest\.json/);
  assert.match(prepareSource, /taskboard-daemon\.mjs/);
  assert.match(prepareSource, /createHash\("sha256"\)/);
  assert.match(daemonSource, /CODEX_TASKBOARD_HOST = options\.host/);
  assert.match(daemonSource, /CODEX_TASKBOARD_PORT = String\(options\.port\)/);
  assert.match(daemonSource, /CODEX_TASKBOARD_DAEMON_VERSION/);
  assert.match(daemonSource, /createTaskboardServer/);
});
