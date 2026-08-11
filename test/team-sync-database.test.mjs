import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createTeamSyncStore } from "../server/team-sync-store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-sync-db-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  t.after(() => database.close());
  const store = createTeamSyncStore({ database, now: () => "2026-08-12T10:00:00.000Z" });
  await store.upsertProfile({ id: "alpha", serverUrl: "https://alpha.example.test", active: true });
  await store.upsertProfile({ id: "beta", serverUrl: "https://beta.example.test", active: false });
  return { database, store };
}

test("sync state, entity bases, outbox operations, and retry state stay isolated by profile", async (t) => {
  const { store } = await fixture(t);
  await store.setSyncState("alpha", { cursor: "17", status: "offline", retryCount: 2 });
  await store.setSyncState("beta", { cursor: "4", status: "online", retryCount: 0 });
  await store.saveEntityBase("alpha", {
    entityType: "task",
    entityId: "TASK-1",
    remoteVersion: 7,
    snapshot: { title: "Base" },
  });

  const first = await store.appendOperation({
    profileId: "alpha",
    id: "op-1",
    idempotencyKey: "device-1:op-1",
    entityType: "task",
    entityId: "TASK-1",
    operationType: "update",
    baseVersion: 7,
    baseSnapshot: { title: "Base" },
    change: { title: "Local", workspacePath: "/Users/example/private", worktreePath: "/tmp/private" },
    userId: "user-1",
    deviceId: "device-1",
  });
  const duplicate = await store.appendOperation({ ...first, change: { title: "Ignored" } });
  await store.appendOperation({
    profileId: "alpha",
    id: "op-2",
    idempotencyKey: "device-1:op-2",
    entityType: "comment",
    entityId: "comment-1",
    operationType: "create",
    baseVersion: 0,
    baseSnapshot: null,
    change: { body: "hello" },
    userId: "user-1",
    deviceId: "device-1",
  });
  await store.markRetry("alpha", "op-1", {
    retryCount: 3,
    nextRetryAt: "2026-08-12T10:01:00.000Z",
    error: "offline",
  });

  assert.equal(duplicate.id, first.id);
  assert.deepEqual(await store.getSyncState("alpha"), {
    profileId: "alpha",
    cursor: "17",
    status: "offline",
    paused: false,
    retryCount: 2,
    nextRetryAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
  });
  assert.equal((await store.getEntityBase("alpha", "task", "TASK-1")).remoteVersion, 7);
  assert.equal(await store.getEntityBase("beta", "task", "TASK-1"), null);
  const pending = await store.listPending("alpha");
  assert.deepEqual(pending.map((operation) => operation.id), ["op-1", "op-2"]);
  assert.equal(pending[0].retryCount, 3);
  assert.deepEqual(pending[0].change, { title: "Local" });
  assert.deepEqual(await store.listPending("beta"), []);
});

test("branch records are durable and transactional acknowledgement advances the cursor before pruning outbox", async (t) => {
  const { store } = await fixture(t);
  await store.appendOperation({
    profileId: "alpha",
    id: "op-1",
    idempotencyKey: "op-1",
    entityType: "task",
    entityId: "TASK-1",
    operationType: "update",
    baseVersion: 1,
    baseSnapshot: { title: "Base" },
    change: { title: "Local" },
    userId: "user-1",
    deviceId: "device-1",
  });
  await store.appendOperation({
    profileId: "alpha",
    id: "op-2",
    idempotencyKey: "op-2",
    entityType: "task",
    entityId: "TASK-2",
    operationType: "update",
    baseVersion: 3,
    baseSnapshot: { title: "Second" },
    change: { title: "Second local" },
    userId: "user-1",
    deviceId: "device-1",
  });
  await store.recordBranch({
    id: "local-branch-1",
    profileId: "alpha",
    serverBranchId: "branch-remote-1",
    taskId: "TASK-1",
    baseRevision: 1,
    currentMainRevision: 2,
    proposedRevision: 2,
    baseSnapshot: { title: "Base" },
    mainSnapshot: { title: "Remote" },
    branchSnapshot: { title: "Local" },
    authorId: "user-1",
    deviceId: "device-1",
  });

  await assert.rejects(
    store.acknowledgeBatch("alpha", {
      cursor: "22",
      acknowledgedOperationIds: ["op-1", "missing"],
      entityBases: [],
    }),
    /missing/,
  );
  assert.equal((await store.getSyncState("alpha")).cursor, "0");
  assert.deepEqual((await store.listPending("alpha")).map((operation) => operation.id), ["op-1", "op-2"]);

  await store.acknowledgeBatch("alpha", {
    cursor: "22",
    acknowledgedOperationIds: ["op-1"],
    entityBases: [{
      entityType: "task",
      entityId: "TASK-1",
      remoteVersion: 2,
      snapshot: { title: "Remote" },
    }],
  });
  assert.equal((await store.getSyncState("alpha")).cursor, "22");
  assert.deepEqual((await store.listPending("alpha")).map((operation) => operation.id), ["op-2"]);
  assert.equal((await store.listBranches("alpha"))[0].serverBranchId, "branch-remote-1");
});

test("local mutation and outbox append share one transaction", async (t) => {
  const { database, store } = await fixture(t);
  await assert.rejects(
    store.appendOperation({
      profileId: "alpha",
      id: "op-failed",
      idempotencyKey: "op-failed",
      entityType: "task",
      entityId: "TASK-3",
      operationType: "update",
      baseVersion: 0,
      baseSnapshot: null,
      change: { title: "Failed" },
      userId: "user-1",
      deviceId: "device-1",
    }, {
      applyLocal(rawDatabase) {
        rawDatabase.prepare("UPDATE projects SET name = 'Changed' WHERE id = 'local'").run();
        throw new Error("local mutation failed");
      },
    }),
    /local mutation failed/,
  );
  assert.equal(database.getProject("local").name, "全局");
  assert.deepEqual(await store.listPending("alpha"), []);
});
