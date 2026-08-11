import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/app.mjs";
import { createTeamConfigStore } from "../server/team-config.mjs";
import { createTeamSyncWorker } from "../server/team-sync.mjs";
import { createTeamSyncStore } from "../server/team-sync-store.mjs";

async function fixture(t, { remoteFetch, token = "token-alpha", now, setTimer, clearTimer } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  t.after(() => database.close());
  const store = createTeamSyncStore({ database, now: now ?? (() => "2026-08-12T10:00:00.000Z") });
  await store.upsertProfile({ id: "alpha", serverUrl: "https://alpha.example.test", active: true });
  await store.upsertProfile({ id: "beta", serverUrl: "https://beta.example.test", active: false });
  const config = {
    read: async () => ({
      activeProfileId: "alpha",
      profiles: [
        { id: "alpha", url: "https://alpha.example.test", active: true },
        { id: "beta", url: "https://beta.example.test", active: false },
      ],
    }),
  };
  const applied = [];
  const worker = createTeamSyncWorker({
    configStore: config,
    keychain: { get: async () => token },
    syncStore: store,
    remoteFetch,
    applyRemoteChanges: async (changes) => applied.push(...changes),
    deviceId: "device-1",
    clientVersion: "0.3.0",
    nowMs: () => Date.parse("2026-08-12T10:00:00.000Z"),
    setTimer,
    clearTimer,
  });
  return { applied, database, store, worker };
}

function operation(profileId, id, entityId = "TASK-1") {
  return {
    profileId,
    id,
    idempotencyKey: `device-1:${id}`,
    entityType: "task",
    entityId,
    operationType: "update",
    baseVersion: 1,
    baseSnapshot: { id: entityId, title: "Base", version: 1 },
    change: { title: "Local" },
    userId: "owner",
    deviceId: "device-1",
  };
}

test("the worker pulls before pushing, acknowledges accepted work, and isolates inactive profiles", async (t) => {
  const requests = [];
  const { applied, store, worker } = await fixture(t, {
    remoteFetch: async (request) => {
      requests.push({ url: request.url, body: request.method === "POST" ? await request.clone().json() : null });
      if (request.url.includes("/pull")) {
        return Response.json({
          cursor: "5",
          changes: [{
            sequence: "5",
            entityType: "task",
            entityId: "TASK-2",
            revision: 2,
            operationType: "update",
            snapshot: { id: "TASK-2", title: "Remote", version: 2 },
          }],
        });
      }
      return Response.json({
        cursor: "6",
        results: [{ operationId: "op-alpha", status: "accepted", entityId: "TASK-1", version: 2 }],
      });
    },
  });
  await store.appendOperation(operation("alpha", "op-alpha"));
  await store.appendOperation(operation("beta", "op-beta", "TASK-BETA"));

  const result = await worker.syncNow();
  assert.equal(result.status, "online");
  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), ["/api/sync/pull", "/api/sync/push"]);
  assert.equal(requests[1].body.operations[0].id, "op-alpha");
  assert.deepEqual(applied.map((change) => change.entityId), ["TASK-2"]);
  assert.deepEqual(await store.listPending("alpha"), []);
  assert.deepEqual((await store.listPending("beta")).map((entry) => entry.id), ["op-beta"]);
  assert.equal((await store.getSyncState("alpha")).cursor, "6");
});

test("branch responses are durable while unrelated acknowledgements continue", async (t) => {
  const { store, worker } = await fixture(t, {
    remoteFetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/pull")) return Response.json({ cursor: "2", changes: [] });
      if (url.pathname.endsWith("/push")) {
        return Response.json({
          cursor: "3",
          results: [
            { operationId: "op-conflict", status: "branch", branchId: "branch-1", entityId: "TASK-1", mainVersion: 2 },
            { operationId: "op-ok", status: "accepted", entityId: "TASK-2", version: 2 },
          ],
        });
      }
      if (url.pathname === "/api/task-branches/branch-1") {
        return Response.json({ branch: {
          id: "branch-1",
          taskId: "TASK-1",
          baseRevision: 1,
          currentMainRevision: 2,
          proposedRevision: 2,
          baseSnapshot: { title: "Base" },
          mainSnapshot: { title: "Remote" },
          branchSnapshot: { title: "Local" },
          authorId: "owner",
          deviceId: "device-1",
          state: "open",
        } });
      }
      throw new Error(`Unexpected request ${request.url}`);
    },
  });
  await store.appendOperation(operation("alpha", "op-conflict", "TASK-1"));
  await store.appendOperation(operation("alpha", "op-ok", "TASK-2"));
  await worker.syncNow();
  assert.deepEqual(await store.listPending("alpha"), []);
  assert.equal((await store.listBranches("alpha"))[0].serverBranchId, "branch-1");
  assert.equal((await store.getSyncState("alpha")).cursor, "3");
});

test("independent fields rebase onto the pulled task while overlapping fields keep the old base", async (t) => {
  const pushed = [];
  const { store, worker } = await fixture(t, {
    remoteFetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/pull")) {
        return Response.json({
          cursor: "2",
          changes: [{
            sequence: "2",
            entityType: "task",
            entityId: "TASK-1",
            revision: 2,
            operationType: "update",
            snapshot: { id: "TASK-1", title: "Base", description: "Remote", version: 2 },
          }, {
            sequence: "2",
            entityType: "task",
            entityId: "TASK-2",
            revision: 2,
            operationType: "update",
            snapshot: { id: "TASK-2", title: "Remote title", description: "", version: 2 },
          }],
        });
      }
      const body = await request.json();
      pushed.push(...body.operations);
      return Response.json({
        cursor: "3",
        results: body.operations.map((entry) => ({
          operationId: entry.id,
          status: "accepted",
          entityId: entry.entityId,
          version: entry.baseVersion + 1,
        })),
      });
    },
  });
  await store.appendOperation(operation("alpha", "op-disjoint", "TASK-1"));
  await store.appendOperation(operation("alpha", "op-overlap", "TASK-2"));
  await worker.syncNow();
  assert.equal(pushed.find((entry) => entry.id === "op-disjoint").baseVersion, 2);
  assert.equal(pushed.find((entry) => entry.id === "op-disjoint").baseSnapshot.description, "Remote");
  assert.equal(pushed.find((entry) => entry.id === "op-overlap").baseVersion, 1);
});

test("offline failures preserve the outbox and use bounded exponential backoff", async (t) => {
  let attempts = 0;
  let clock = Date.parse("2026-08-12T10:00:00.000Z");
  const { store, worker } = await fixture(t, {
    now: () => new Date(clock).toISOString(),
    remoteFetch: async () => {
      attempts += 1;
      throw new Error("offline");
    },
  });
  await store.appendOperation(operation("alpha", "op-offline"));
  const first = await worker.syncNow();
  assert.equal(first.status, "offline");
  assert.equal(first.retryInMs, 1_000);
  assert.deepEqual((await store.listPending("alpha")).map((entry) => entry.id), ["op-offline"]);
  clock += 1_000;
  const second = await worker.syncNow({ force: true });
  assert.equal(second.retryInMs, 2_000);
  assert.equal(attempts, 2);

  await store.setSyncState("alpha", { retryCount: 20 });
  const bounded = await worker.syncNow({ force: true });
  assert.equal(bounded.retryInMs, 300_000);
});

test("invalid credentials pause synchronization until explicit resume", async (t) => {
  let calls = 0;
  const { store, worker } = await fixture(t, {
    remoteFetch: async () => {
      calls += 1;
      return Response.json({ error: { code: "UNAUTHORIZED", message: "expired" } }, { status: 401 });
    },
  });
  await store.appendOperation(operation("alpha", "op-auth"));
  const result = await worker.syncNow();
  assert.equal(result.status, "invalid_credentials");
  assert.equal((await store.getSyncState("alpha")).paused, true);
  await worker.syncNow();
  assert.equal(calls, 1);
  await worker.resume();
  assert.equal((await store.getSyncState("alpha")).paused, false);
});

test("the local daemon queues mutations and exposes sync status controls", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = createTeamConfigStore({
    configPath: path.join(directory, "team-servers.json"),
    randomId: () => "alpha",
  });
  await config.create({ name: "Alpha", url: "https://alpha.example.test" });
  const app = createTaskboardServer({
    dataDirectory: directory,
    teamConfigStore: config,
    teamKeychain: { get: async () => "token-alpha", set: async () => {}, delete: async () => {} },
    remoteFetch: async () => { throw new Error("offline"); },
    enableTeamSyncTimer: false,
    deviceId: "device-1",
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "local",
      title: "Queued locally",
      status: "todo",
      priority: "none",
      labels: [],
    }),
  });
  assert.equal(created.status, 201);
  const task = (await created.json()).task;
  const commentResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Queued comment" }),
  });
  assert.equal(commentResponse.status, 201);
  const attachmentResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("offline.txt"),
    },
    body: "queued attachment",
  });
  assert.equal(attachmentResponse.status, 201);
  const status = await fetch(`${baseUrl}/api/team/sync/status`).then((response) => response.json());
  assert.equal(status.profileId, "alpha");
  assert.equal(status.pendingOperations, 3);

  const paused = await fetch(`${baseUrl}/api/team/sync/pause`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(paused.paused, true);
  const resumed = await fetch(`${baseUrl}/api/team/sync/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(resumed.paused, false);
  const synchronized = await fetch(`${baseUrl}/api/team/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(synchronized.status, "offline");
  assert.equal(synchronized.pendingOperations, undefined);
});

test("daemon startup synchronizes immediately, schedules reconnects, and cancels them on shutdown", async (t) => {
  const timers = [];
  const cleared = [];
  let pulls = 0;
  const { worker } = await fixture(t, {
    remoteFetch: async () => {
      pulls += 1;
      return Response.json({ cursor: "0", changes: [] });
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer),
  });
  await worker.start({ intervalMs: 25_000 });
  assert.equal(pulls, 1);
  assert.equal(timers[0].delay, 25_000);
  await timers[0].callback();
  assert.equal(pulls, 2);
  worker.stop();
  assert.equal(cleared.length, 1);
});
