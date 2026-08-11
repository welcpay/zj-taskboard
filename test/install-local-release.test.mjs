import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  appBackupPath,
  readTaskboardCounts,
  restoreAppArchive,
  waitForDaemonVersion,
} from "../scripts/install-local-release.mjs";

const installerSource = await readFile(new URL("../scripts/install-local-release.mjs", import.meta.url), "utf8");

test("the local installer reads project and issue counts without mutating data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-release-test-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE projects (id TEXT); CREATE TABLE tasks (id TEXT); INSERT INTO projects VALUES ('p'); INSERT INTO tasks VALUES ('t1'), ('t2');");
  db.close();
  assert.deepEqual(readTaskboardCounts(filename), { projects: 1, issues: 2 });
  await rm(directory, { recursive: true, force: true });
});

test("local upgrades archive the old App outside LaunchServices discovery", () => {
  const backup = appBackupPath({
    dataDirectory: "/Users/test/Library/Application Support/Codex Taskboard",
    version: "0.3.0",
    timestamp: "2026-08-12T01:02:03.000Z",
  });
  assert.equal(
    backup,
    "/Users/test/Library/Application Support/Codex Taskboard/backups/apps/Codex Taskboard-before-0.3.0-2026-08-12T01-02-03-000Z.app.zip",
  );
  assert.doesNotMatch(installerSource, /\.Trash/);
  assert.match(installerSource, /ditto[\s\S]*?--keepParent/);
  assert.match(installerSource, /\.app\.zip/);
});

test("local upgrades replace the service without self-AppleScript or data deletion", () => {
  assert.match(installerSource, /com\.chuspeeism\.codex-taskboard\.daemon/);
  assert.match(installerSource, /launchctl[\s\S]*?bootout/);
  assert.doesNotMatch(installerSource, /osascript|AppleScript/i);
  assert.doesNotMatch(installerSource, /remove_dir_all[\s\S]*?Application Support|rmSync[\s\S]*?Application Support/);
  assert.match(installerSource, /Historical data verification failed/);
  assert.match(installerSource, /restoreAppArchive/);
  assert.match(installerSource, /waitForDaemonVersion/);
});

test("daemon verification retries until the expected installed version is healthy", async () => {
  const responses = [
    Promise.reject(new Error("offline")),
    Promise.resolve(Response.json({ product: "codex-taskboard", daemonVersion: "0.2.9" })),
    Promise.resolve(Response.json({ product: "codex-taskboard", daemonVersion: "0.3.0" })),
  ];
  let sleeps = 0;
  const result = await waitForDaemonVersion("0.3.0", {
    fetchImpl: async () => responses.shift(),
    sleep: async () => { sleeps += 1; },
    timeoutMs: 5_000,
    now: (() => { let value = 0; return () => (value += 100); })(),
  });
  assert.equal(result.daemonVersion, "0.3.0");
  assert.equal(sleeps, 2);
});

test("an archived App is restored to its original bundle path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-app-restore-test-"));
  const applications = path.join(directory, "Applications");
  const installed = path.join(applications, "Codex Taskboard.app");
  const marker = path.join(installed, "Contents", "version.txt");
  const backup = path.join(directory, "Codex Taskboard.app.zip");
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, "old-version");
  const archived = spawnSync(
    "/usr/bin/ditto",
    ["-c", "-k", "--keepParent", "--sequesterRsrc", installed, backup],
    { encoding: "utf8" },
  );
  assert.equal(archived.status, 0, archived.stderr);
  await rm(installed, { recursive: true, force: true });
  assert.equal(await restoreAppArchive(backup, installed), true);
  assert.equal(await readFile(marker, "utf8"), "old-version");
  await rm(directory, { recursive: true, force: true });
});
