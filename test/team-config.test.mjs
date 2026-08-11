import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/app.mjs";
import { createKeychainStore } from "../server/keychain.mjs";
import { createTeamConfigStore } from "../server/team-config.mjs";

test("multiple Team Server profiles retain isolated state and exactly one active profile", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "team-servers.json");
  let sequence = 0;
  const store = createTeamConfigStore({
    configPath,
    randomId: () => `profile-${++sequence}`,
  });

  const alpha = await store.create({
    name: "Alpha",
    url: "https://alpha.example.test",
    organizationId: "org-alpha",
  });
  const beta = await store.create({
    name: "Beta",
    url: "https://beta.example.test/base/",
    organizationId: "org-beta",
  });
  await store.updateState(alpha.id, {
    cursor: "17",
    status: "offline",
    pendingOperations: 3,
    workspaceMappings: { projectA: "/Users/example/alpha" },
  });
  await store.updateState(beta.id, {
    cursor: "9",
    status: "online",
    pendingOperations: 0,
    workspaceMappings: { projectB: "/Users/example/beta" },
  });
  await store.activate(beta.id);

  const config = await store.read();
  assert.equal(config.activeProfileId, beta.id);
  assert.equal(config.profiles.filter((profile) => profile.active).length, 1);
  assert.deepEqual(config.profiles.find((profile) => profile.id === alpha.id)?.sync, {
    cursor: "17",
    status: "offline",
    pendingOperations: 3,
    lastSuccessfulSyncAt: null,
    paused: false,
  });
  assert.deepEqual(
    config.profiles.find((profile) => profile.id === alpha.id)?.workspaceMappings,
    { projectA: "/Users/example/alpha" },
  );
  assert.equal(config.profiles.find((profile) => profile.id === beta.id)?.url, "https://beta.example.test/base");
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("Team Server tokens use profile-specific Keychain entries and never enter JSON", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-keychain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "team-servers.json");
  const config = createTeamConfigStore({ configPath, randomId: () => "profile-alpha" });
  await config.create({ name: "Alpha", url: "https://alpha.example.test", token: "must-not-persist" });
  assert.doesNotMatch(await readFile(configPath, "utf8"), /must-not-persist/);

  const calls = [];
  const keychain = createKeychainStore({
    service: "com.chuspeeism.codex-taskboard.team-token",
    runner: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (args[0] === "find-generic-password") return { stdout: "token-alpha\n" };
      return { stdout: "" };
    },
  });
  await keychain.set("profile-alpha", "token-alpha");
  assert.equal(await keychain.get("profile-alpha"), "token-alpha");
  await keychain.delete("profile-alpha");
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["/usr/bin/security", ["add-generic-password", "-U", "-s", "com.chuspeeism.codex-taskboard.team-token", "-a", "profile-alpha", "-w", "token-alpha"]],
    ["/usr/bin/security", ["find-generic-password", "-s", "com.chuspeeism.codex-taskboard.team-token", "-a", "profile-alpha", "-w"]],
    ["/usr/bin/security", ["delete-generic-password", "-s", "com.chuspeeism.codex-taskboard.team-token", "-a", "profile-alpha"]],
  ]);
});

test("Team Server profiles require HTTPS and cannot activate unknown ids", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTeamConfigStore({ configPath: path.join(directory, "config.json") });
  await assert.rejects(
    store.create({ name: "Unsafe", url: "http://team.example.test" }),
    /HTTPS/,
  );
  await assert.rejects(store.activate("missing"), /does not exist/);
});

test("Team Server APIs return stable validation and missing-profile errors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    teamKeychain: { set: async () => {}, get: async () => null, delete: async () => {} },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const invalid = await fetch(`${baseUrl}/api/team/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Unsafe", url: "http://unsafe.example.test" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_TEAM_PROFILE");

  const missing = await fetch(`${baseUrl}/api/team/profiles/missing`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Missing" }),
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "TEAM_PROFILE_NOT_FOUND");
});

test("local Team Server APIs manage profiles, Keychain login, activation, and connection tests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-team-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = createTeamConfigStore({
    configPath: path.join(directory, "team-servers.json"),
    randomId: () => "profile-alpha",
  });
  const tokens = new Map();
  const keychain = {
    set: async (id, token) => tokens.set(id, token),
    get: async (id) => tokens.get(id) ?? null,
    delete: async (id) => tokens.delete(id),
  };
  const remoteRequests = [];
  const app = createTaskboardServer({
    dataDirectory: directory,
    teamConfigStore: config,
    teamKeychain: keychain,
    remoteFetch: async (request) => {
      remoteRequests.push(request);
      if (new URL(request.url).pathname === "/api/updates/latest.json") {
        return new Response(JSON.stringify({
          version: "0.3.0",
          manifest: {
            version: "0.3.0",
            platforms: {
              "darwin-universal": {
                url: "https://alpha.example.test/updates/app.tar.gz",
                signature: "updater-signature",
              },
            },
          },
          signature: "manifest-signature",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        user: { id: "user-1", name: "Alice" },
        role: "member",
        serverVersion: "1.0.0",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = (pathname, init) => fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  }).then(async (response) => ({ response, body: await response.json() }));

  const created = await api("/api/team/profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Alpha", url: "https://alpha.example.test" }),
  });
  assert.equal(created.response.status, 201);
  await api("/api/team/profiles/profile-alpha/login", {
    method: "POST",
    body: JSON.stringify({ token: "token-alpha" }),
  });
  const tested = await api("/api/team/profiles/profile-alpha/test", { method: "POST", body: "{}" });
  assert.equal(tested.response.status, 200);
  assert.equal(tested.body.connection.user.name, "Alice");
  assert.equal(remoteRequests[0].headers.get("authorization"), "Bearer token-alpha");
  await api("/api/team/profiles/profile-alpha/activate", { method: "POST", body: "{}" });
  const listed = await api("/api/team/profiles");
  assert.equal(listed.body.activeProfileId, "profile-alpha");
  assert.equal(listed.body.profiles[0].hasToken, true);
  assert.doesNotMatch(JSON.stringify(listed.body), /token-alpha/);

  const updated = await api("/api/team/profiles/profile-alpha", {
    method: "PATCH",
    body: JSON.stringify({ name: "Alpha Updated", updateMirror: true }),
  });
  assert.equal(updated.body.profile.name, "Alpha Updated");
  assert.equal(updated.body.profile.updateMirror, true);
  assert.equal(updated.body.profile.hasToken, true);

  const mirroredUpdate = await api("/api/team/updates/latest.json");
  assert.equal(mirroredUpdate.response.status, 200);
  assert.equal(mirroredUpdate.body.version, "0.3.0");
  assert.equal(mirroredUpdate.body.platforms["darwin-universal"].signature, "updater-signature");
  assert.equal(remoteRequests.at(-1).headers.get("authorization"), "Bearer token-alpha");

  const unknownLogin = await api("/api/team/profiles/missing/login", {
    method: "POST",
    body: JSON.stringify({ token: "orphan-token" }),
  });
  assert.equal(unknownLogin.response.status, 404);
  assert.equal(tokens.has("missing"), false);

  const loggedOut = await api("/api/team/profiles/profile-alpha/login", { method: "DELETE" });
  assert.equal(loggedOut.body.authenticated, false);
  assert.equal(tokens.has("profile-alpha"), false);

  await api("/api/team/profiles/profile-alpha/login", {
    method: "POST",
    body: JSON.stringify({ token: "token-alpha-2" }),
  });
  const deleted = await api("/api/team/profiles/profile-alpha", { method: "DELETE" });
  assert.equal(deleted.body.activeProfileId, null);
  assert.equal(deleted.body.profiles.length, 0);
  assert.equal(tokens.has("profile-alpha"), false);
});
