import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { appBackupPath, readTaskboardCounts } from "../scripts/install-local-release.mjs";

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
});
