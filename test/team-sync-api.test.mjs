import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

let cloud;

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

async function createUser(id, name, role, token) {
  await cloud.db.prepare(`
    INSERT INTO team_users (id, display_name, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, name, role, "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z").run();
  await cloud.db.prepare(`
    INSERT INTO team_access_tokens (token_hash, user_id, name, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(await tokenHash(token), id, "test", "2026-08-12T00:00:00.000Z").run();
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function push(token, operations) {
  return cloud.request("/api/sync/push", {
    method: "POST",
    headers: bearer(token),
    json: { deviceId: "device-1", clientVersion: "0.3.0", operations },
  });
}

before(async () => {
  cloud = await createCloudWorkerHarness();
  await createUser("owner", "Owner", "member", "token-owner");
  await createUser("outsider", "Outsider", "member", "token-outsider");
  await createUser("admin", "Admin", "admin", "token-admin");
});

after(async () => {
  await cloud?.dispose();
});

test("Bearer tokens expose the current user, role, and server compatibility", async () => {
  const missing = await cloud.request("/api/team/session", {
    headers: bearer("invalid"),
  });
  assert.equal(missing.response.status, 401);

  const session = await cloud.request("/api/team/session", {
    headers: bearer("token-owner"),
  });
  assert.equal(session.response.status, 200);
  assert.deepEqual(session.body, {
    user: { id: "owner", name: "Owner" },
    role: "member",
    serverVersion: "1.0.0",
    minimumClientVersion: "0.3.0",
  });
});

test("pull is monotonic and push is idempotent while concurrent task edits create branches", async () => {
  await cloud.request("/api/projects", {
    method: "POST",
    actorName: "Bootstrap",
    json: { id: "sync", name: "Sync", workspacePath: "/tmp/local-only" },
  });
  const taskOne = await cloud.request("/api/tasks", {
    method: "POST",
    actorName: "Bootstrap",
    json: { projectId: "sync", title: "One", status: "todo", priority: "none", labels: [] },
  });
  const taskTwo = await cloud.request("/api/tasks", {
    method: "POST",
    actorName: "Bootstrap",
    json: { projectId: "sync", title: "Two", status: "todo", priority: "none", labels: [] },
  });
  for (const task of [taskOne.body.task, taskTwo.body.task]) {
    await cloud.db.prepare(`
      UPDATE tasks
      SET creator_type = 'user', creator_id = 'owner', creator_name = 'Owner',
          assignee_type = 'user', assignee_id = 'owner', assignee_name = 'Owner'
      WHERE id = ?
    `).bind(task.id).run();
  }

  const firstOperation = {
    id: "op-1",
    idempotencyKey: "device-1:op-1",
    entityType: "task",
    entityId: taskOne.body.task.id,
    operationType: "update",
    baseVersion: 1,
    baseSnapshot: taskOne.body.task,
    change: { title: "Owner edit" },
  };
  const accepted = await push("token-owner", [firstOperation]);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.results[0].status, "accepted");
  const cursorAfterFirst = accepted.body.cursor;

  const repeated = await push("token-owner", [firstOperation]);
  assert.equal(repeated.response.status, 200);
  assert.deepEqual(repeated.body.results, accepted.body.results);
  assert.equal(repeated.body.cursor, cursorAfterFirst);

  const pulled = await cloud.request(`/api/sync/pull?cursor=0`, {
    headers: bearer("token-owner"),
  });
  assert.equal(pulled.response.status, 200);
  assert.equal(pulled.body.cursor, cursorAfterFirst);
  assert.equal(pulled.body.changes.length, 1);
  assert.equal(pulled.body.changes[0].snapshot.title, "Owner edit");
  const unchanged = await cloud.request(`/api/sync/pull?cursor=${cursorAfterFirst}`, {
    headers: bearer("token-owner"),
  });
  assert.deepEqual(unchanged.body.changes, []);
  assert.equal(unchanged.body.cursor, cursorAfterFirst);

  const concurrent = await push("token-outsider", [{
    id: "op-stale",
    idempotencyKey: "device-1:op-stale",
    entityType: "task",
    entityId: taskOne.body.task.id,
    operationType: "update",
    baseVersion: 1,
    baseSnapshot: taskOne.body.task,
    change: { description: "Concurrent proposal" },
  }, {
    id: "op-independent",
    idempotencyKey: "device-1:op-independent",
    entityType: "task",
    entityId: taskTwo.body.task.id,
    operationType: "update",
    baseVersion: 1,
    baseSnapshot: taskTwo.body.task,
    change: { title: "Independent edit" },
  }]);
  assert.equal(concurrent.response.status, 200);
  assert.deepEqual(concurrent.body.results.map((result) => result.status), ["branch", "accepted"]);
  const branchId = concurrent.body.results[0].branchId;
  assert.ok(branchId);

  const branches = await cloud.request(`/api/tasks/${taskOne.body.task.id}/branches`, {
    headers: bearer("token-owner"),
  });
  assert.equal(branches.body.branches.length, 1);
  assert.equal(branches.body.branches[0].id, branchId);

  const forbidden = await cloud.request(`/api/task-branches/${branchId}/promote`, {
    method: "POST",
    headers: bearer("token-outsider"),
    json: {},
  });
  assert.equal(forbidden.response.status, 403);

  const promoted = await cloud.request(`/api/task-branches/${branchId}/promote`, {
    method: "POST",
    headers: bearer("token-owner"),
    json: {},
  });
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.body.branch.state, "promoted");
  assert.equal(promoted.body.task.description, "Concurrent proposal");
});

test("an offline-created task keeps its client id when uploaded", async () => {
  const created = await push("token-owner", [{
    id: "op-create-task",
    idempotencyKey: "op-create-task",
    entityType: "task",
    entityId: "offline-created-task",
    operationType: "create",
    baseVersion: 0,
    baseSnapshot: null,
    change: {
      projectId: "sync",
      title: "Created offline",
      description: "Queued before reconnect",
      status: "todo",
      priority: "medium",
      labels: ["offline"],
    },
  }]);
  assert.equal(created.response.status, 200);
  assert.equal(created.body.results[0].status, "accepted");
  assert.equal(created.body.results[0].entityId, "offline-created-task");
  const task = await cloud.request("/api/tasks/offline-created-task", {
    headers: bearer("token-owner"),
  });
  assert.equal(task.response.status, 200);
  assert.equal(task.body.task.title, "Created offline");
  assert.equal(task.body.task.creatorId, "owner");
});

test("an administrator can complete an editable three-way merge", async () => {
  const task = (await cloud.request("/api/tasks?projectId=sync", {
    headers: bearer("token-owner"),
  })).body.tasks.find((candidate) => candidate.title === "Independent edit");
  const current = (await cloud.request(`/api/tasks/${task.id}`, {
    headers: bearer("token-owner"),
  })).body.task;
  const winner = await push("token-owner", [{
    id: "op-winner",
    idempotencyKey: "op-winner",
    entityType: "task",
    entityId: task.id,
    operationType: "update",
    baseVersion: current.version,
    baseSnapshot: current,
    change: { title: "Main winner" },
  }]);
  assert.equal(winner.body.results[0].status, "accepted");
  const branch = await push("token-outsider", [{
    id: "op-merge",
    idempotencyKey: "op-merge",
    entityType: "task",
    entityId: task.id,
    operationType: "update",
    baseVersion: current.version,
    baseSnapshot: current,
    change: { description: "Branch proposal" },
  }]);
  const branchId = branch.body.results[0].branchId;
  const merged = await cloud.request(`/api/task-branches/${branchId}/merge`, {
    method: "POST",
    headers: bearer("token-admin"),
    json: { snapshot: { ...current, title: "Main winner", description: "Branch proposal" } },
  });
  assert.equal(merged.response.status, 200);
  assert.equal(merged.body.branch.state, "merged");
  assert.equal(merged.body.task.title, "Main winner");
  assert.equal(merged.body.task.description, "Branch proposal");
});

test("comments and attachments append independently while conflicting comment edits become branch operations", async () => {
  const task = (await cloud.request("/api/tasks?projectId=sync", {
    headers: bearer("token-owner"),
  })).body.tasks[0];
  const appended = await push("token-outsider", [{
    id: "op-comment-1",
    idempotencyKey: "op-comment-1",
    entityType: "comment",
    entityId: "comment-sync-1",
    operationType: "create",
    baseVersion: 0,
    baseSnapshot: null,
    change: { taskId: task.id, body: "First comment" },
  }, {
    id: "op-comment-2",
    idempotencyKey: "op-comment-2",
    entityType: "comment",
    entityId: "comment-sync-2",
    operationType: "create",
    baseVersion: 0,
    baseSnapshot: null,
    change: { taskId: task.id, body: "Second comment" },
  }, {
    id: "op-attachment-1",
    idempotencyKey: "op-attachment-1",
    entityType: "attachment",
    entityId: "attachment-sync-1",
    operationType: "create",
    baseVersion: 0,
    baseSnapshot: null,
    change: {
      taskId: task.id,
      filename: "note.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("offline attachment").toString("base64"),
    },
  }]);
  assert.deepEqual(appended.body.results.map((result) => result.status), [
    "accepted", "accepted", "accepted",
  ]);
  const comments = await cloud.request(`/api/tasks/${task.id}/comments`, {
    headers: bearer("token-owner"),
  });
  assert.deepEqual(
    comments.body.comments.filter((comment) => comment.id.startsWith("comment-sync-"))
      .map((comment) => comment.body),
    ["First comment", "Second comment"],
  );
  const attachment = await cloud.request("/api/attachments/attachment-sync-1/content", {
    headers: bearer("token-owner"),
  });
  assert.equal(attachment.response.status, 200);
  assert.equal(attachment.body, "offline attachment");

  const firstEdit = await push("token-outsider", [{
    id: "op-comment-edit-1",
    idempotencyKey: "op-comment-edit-1",
    entityType: "comment",
    entityId: "comment-sync-1",
    operationType: "update",
    baseVersion: 1,
    baseSnapshot: { id: "comment-sync-1", taskId: task.id, body: "First comment", version: 1 },
    change: { body: "First winner" },
  }]);
  assert.equal(firstEdit.body.results[0].status, "accepted");
  const conflict = await push("token-outsider", [{
    id: "op-comment-edit-2",
    idempotencyKey: "op-comment-edit-2",
    entityType: "comment",
    entityId: "comment-sync-1",
    operationType: "update",
    baseVersion: 1,
    baseSnapshot: { id: "comment-sync-1", taskId: task.id, body: "First comment", version: 1 },
    change: { body: "Review proposal" },
  }]);
  assert.equal(conflict.body.results[0].status, "branch");
  const promoted = await cloud.request(`/api/task-branches/${conflict.body.results[0].branchId}/promote`, {
    method: "POST",
    headers: bearer("token-owner"),
    json: {},
  });
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.body.comment.body, "Review proposal");
});

test("the active Team Server update artifact is delivered as a signed mirror manifest", async () => {
  await cloud.db.prepare(`
    INSERT INTO team_update_artifacts (version, manifest_json, signature, published_at, active)
    VALUES (?, ?, ?, ?, 1)
  `).bind(
    "0.3.0",
    JSON.stringify({ version: "0.3.0", platforms: { "darwin-aarch64": { url: "/updates/app.tar.gz" } } }),
    "signed-manifest",
    "2026-08-12T00:00:00.000Z",
  ).run();
  const result = await cloud.request("/api/updates/latest.json", {
    headers: bearer("token-owner"),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.version, "0.3.0");
  assert.equal(result.body.signature, "signed-manifest");
  assert.equal(result.body.manifest.version, "0.3.0");
});
