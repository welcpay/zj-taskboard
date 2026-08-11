import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readTaskboardCounts } from "../scripts/install-local-release.mjs";

test("the local installer reads project and issue counts without mutating data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-release-test-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE projects (id TEXT); CREATE TABLE tasks (id TEXT); INSERT INTO projects VALUES ('p'); INSERT INTO tasks VALUES ('t1'), ('t2');");
  db.close();
  assert.deepEqual(readTaskboardCounts(filename), { projects: 1, issues: 2 });
  await rm(directory, { recursive: true, force: true });
});
