#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installRuntime,
  rollbackRuntime,
  runtimeLayout,
  uninstallRuntime,
} from "./daemon-runtime.mjs";

const FIXED_URL = "http://127.0.0.1:47823";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function health() {
  const response = await fetch(`${FIXED_URL}/health`, { signal: AbortSignal.timeout(750) });
  if (!response.ok) throw new Error(`Health returned HTTP ${response.status}`);
  return response.json();
}

async function waitForHealth(expectedVersion, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("Health check did not run");
  while (Date.now() < deadline) {
    try {
      const result = await health();
      if (result.product === "codex-taskboard" && result.daemonVersion === expectedVersion) {
        return result;
      }
      lastError = new Error(`Expected daemon ${expectedVersion}, received ${JSON.stringify(result)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError;
}

async function updateBundleVersion(source, destination, version, { broken = false } = {}) {
  await cp(source, destination, { recursive: true });
  const manifestPath = path.join(destination, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  if (broken) {
    const entry = path.join(destination, "app", "taskboard-daemon.mjs");
    await writeFile(entry, "process.exit(42);\n");
    manifest.files["app/taskboard-daemon.mjs"] = createHash("sha256")
      .update(await readFile(entry))
      .digest("hex");
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

class RestartingDaemon {
  constructor(homeDirectory) {
    this.homeDirectory = homeDirectory;
    this.child = null;
    this.expectedVersion = null;
    this.restart = true;
    this.starts = 0;
  }

  async start(expectedVersion) {
    this.expectedVersion = expectedVersion;
    this.restart = true;
    await this.#spawn();
    return waitForHealth(expectedVersion);
  }

  async #spawn() {
    const layout = runtimeLayout(this.homeDirectory);
    const version = path.basename(await readlink(layout.currentPath));
    const runtime = path.join(layout.runtimeDirectory, version);
    const child = spawn(
      path.join(runtime, "node"),
      [path.join(runtime, "app", "taskboard-daemon.mjs"), "--host", "127.0.0.1", "--port", "47823"],
      { cwd: layout.supportDirectory, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;
    this.starts += 1;
    child.stdout.resume();
    child.stderr.resume();
    child.once("exit", () => {
      if (this.child === child) this.child = null;
      if (this.restart) setTimeout(() => void this.#spawn(), 150);
    });
  }

  async killAndWaitForRestart() {
    const previousPid = this.child?.pid;
    assert.ok(previousPid, "daemon must be running before the crash test");
    this.child.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.child?.pid && this.child.pid !== previousPid) {
        await waitForHealth(this.expectedVersion);
        return { previousPid, restartedPid: this.child.pid };
      }
      await delay(50);
    }
    throw new Error("launchd-equivalent supervisor did not restart the daemon");
  }

  async stop() {
    this.restart = false;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(3_000).then(() => child.kill("SIGKILL")),
    ]);
    this.child = null;
  }
}

export async function verifyDaemonLifecycle({
  bundleDirectory = path.join(root, "src-tauri", "resources", "daemon-runtime"),
} = {}) {
  try {
    const existing = await health();
    throw new Error(`Port 47823 is already owned by ${JSON.stringify(existing)}`);
  } catch (error) {
    if (!String(error.message).startsWith("Port 47823 is already owned")) {
      // Expected: no listener before the isolated lifecycle starts.
    } else {
      throw error;
    }
  }

  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-lifecycle-home."));
  const bundlesDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-lifecycle-bundles."));
  const supervisor = new RestartingDaemon(homeDirectory);
  const results = {};
  try {
    const originalManifest = JSON.parse(await readFile(
      path.join(bundleDirectory, "runtime-manifest.json"),
      "utf8",
    ));
    const original = await installRuntime({ homeDirectory, bundleDirectory });
    results.started = await supervisor.start(original.version);

    results.crashRestart = await supervisor.killAndWaitForRestart();
    assert.notEqual(results.crashRestart.previousPid, results.crashRestart.restartedPid);
    await delay(250);
    results.clientIndependent = await waitForHealth(original.version);

    const nextVersion = `${originalManifest.version.split("-")[0]}-e2e-next`;
    const nextBundle = await updateBundleVersion(
      bundleDirectory,
      path.join(bundlesDirectory, nextVersion),
      nextVersion,
    );
    await supervisor.stop();
    const next = await installRuntime({ homeDirectory, bundleDirectory: nextBundle });
    results.switched = await supervisor.start(next.version);

    const brokenVersion = `${originalManifest.version.split("-")[0]}-e2e-broken`;
    const brokenBundle = await updateBundleVersion(
      bundleDirectory,
      path.join(bundlesDirectory, brokenVersion),
      brokenVersion,
      { broken: true },
    );
    await supervisor.stop();
    const broken = await installRuntime({ homeDirectory, bundleDirectory: brokenBundle });
    await assert.rejects(supervisor.start(broken.version), /fetch failed|Expected daemon|ECONNREFUSED/);
    await supervisor.stop();
    await rollbackRuntime({ homeDirectory, rollback: broken });
    results.rolledBack = await supervisor.start(next.version);

    const dataFile = path.join(runtimeLayout(homeDirectory).supportDirectory, "taskboard.sqlite");
    await supervisor.stop();
    await mkdir(path.dirname(dataFile), { recursive: true });
    await writeFile(dataFile, "preserved-data");
    await uninstallRuntime({ homeDirectory, runner: async () => {} });
    assert.equal(await readFile(dataFile, "utf8"), "preserved-data");
    results.uninstalled = { dataPreserved: true };
    return results;
  } finally {
    await supervisor.stop();
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(bundlesDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyDaemonLifecycle().then((results) => {
    console.log(JSON.stringify({ ok: true, fixedUrl: FIXED_URL, ...results }, null, 2));
  }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
