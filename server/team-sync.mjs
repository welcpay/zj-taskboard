function responseError(response, payload) {
  const error = new Error(payload?.error?.message ?? `Team Server returned HTTP ${response.status}`);
  error.status = response.status;
  error.code = payload?.error?.code ?? `HTTP_${response.status}`;
  return error;
}

async function jsonRequest(fetchImplementation, url, token, init = {}) {
  const response = await fetchImplementation(new Request(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  }));
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error("Team Server returned invalid JSON");
    error.status = response.status;
    error.code = "INVALID_TEAM_RESPONSE";
    throw error;
  }
  if (!response.ok) throw responseError(response, payload);
  return payload;
}

function remoteOperation(operation) {
  return {
    id: operation.id,
    idempotencyKey: operation.idempotencyKey,
    entityType: operation.entityType,
    entityId: operation.entityId,
    operationType: operation.operationType,
    baseVersion: operation.baseVersion,
    baseSnapshot: operation.baseSnapshot,
    change: operation.change,
  };
}

function acceptedBase(operation, result) {
  if (result.status !== "accepted") return null;
  if (operation.operationType === "delete") {
    return {
      entityType: operation.entityType,
      entityId: operation.entityId,
      remoteVersion: result.version,
      snapshot: null,
    };
  }
  return {
    entityType: operation.entityType,
    entityId: operation.entityId,
    remoteVersion: result.version,
    snapshot: {
      ...(operation.baseSnapshot ?? {}),
      ...operation.change,
      id: operation.entityId,
      version: result.version,
    },
  };
}

const NON_CONTENT_FIELDS = new Set([
  "version", "updatedAt", "createdAt", "activityKey", "activityUpdatedAt",
  "participants", "conversationRefs", "previewImage",
]);

function changedFields(base, next) {
  const before = base && typeof base === "object" ? base : {};
  const after = next && typeof next === "object" ? next : {};
  return new Set([...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => (
    !NON_CONTENT_FIELDS.has(key)
    && JSON.stringify(before[key]) !== JSON.stringify(after[key])
  )));
}

export function createTeamSyncWorker({
  configStore,
  keychain,
  syncStore,
  remoteFetch = globalThis.fetch,
  applyRemoteChanges = async () => {},
  deviceId,
  clientVersion,
  nowMs = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const queues = new Map();
  let reconnectTimer = null;
  let stopped = true;

  async function activeProfile() {
    const config = await configStore.read();
    if (!config.activeProfileId) return null;
    return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
  }

  async function setFailure(profileId, status, error, { pause = false } = {}) {
    const state = await syncStore.getSyncState(profileId);
    const retryCount = state.retryCount + 1;
    const retryInMs = Math.min(300_000, 1_000 * (2 ** Math.min(retryCount - 1, 20)));
    const nextRetryAt = new Date(nowMs() + retryInMs).toISOString();
    await syncStore.setSyncState(profileId, {
      status,
      paused: pause,
      retryCount,
      nextRetryAt,
      lastError: error.message,
    });
    for (const operation of await syncStore.listPending(profileId)) {
      await syncStore.markRetry(profileId, operation.id, {
        retryCount,
        nextRetryAt,
        error: error.message,
      });
    }
    return { profileId, status, retryInMs, error: error.message };
  }

  async function run(profile, { force = false } = {}) {
    await syncStore.upsertProfile({ id: profile.id, serverUrl: profile.url, active: true });
    const initialState = await syncStore.getSyncState(profile.id);
    if (initialState.paused && !force) return initialState;
    const token = await keychain.get(profile.id);
    if (!token) {
      const error = new Error("Team Server access token is required");
      return setFailure(profile.id, "invalid_credentials", error, { pause: true });
    }
    try {
      const pull = await jsonRequest(
        remoteFetch,
        `${profile.url}/api/sync/pull?cursor=${encodeURIComponent(initialState.cursor)}`,
        token,
      );
      if (!Array.isArray(pull.changes) || typeof pull.cursor !== "string") {
        throw new Error("Team Server pull response is invalid");
      }
      const pendingBeforePull = await syncStore.listPending(profile.id);
      for (const change of pull.changes) {
        for (const operation of pendingBeforePull.filter((candidate) => (
          candidate.entityType === change.entityType && candidate.entityId === change.entityId
        ))) {
          const remoteFields = changedFields(operation.baseSnapshot, change.snapshot);
          const overlaps = Object.keys(operation.change).some((field) => remoteFields.has(field));
          if (!overlaps) {
            await syncStore.rebaseOperation(profile.id, operation.id, {
              baseVersion: change.revision,
              baseSnapshot: change.snapshot,
            });
          }
        }
      }
      await applyRemoteChanges(pull.changes, { profileId: profile.id });
      for (const change of pull.changes) {
        await syncStore.saveEntityBase(profile.id, {
          entityType: change.entityType,
          entityId: change.entityId,
          remoteVersion: change.revision,
          snapshot: change.snapshot,
        });
      }
      await syncStore.setSyncState(profile.id, {
        cursor: pull.cursor,
        status: "online",
        retryCount: 0,
        nextRetryAt: null,
        lastError: null,
      });

      const pending = await syncStore.listPending(profile.id);
      if (pending.length === 0) {
        return { profileId: profile.id, status: "online", cursor: pull.cursor, pendingOperations: 0 };
      }
      const pushed = await jsonRequest(remoteFetch, `${profile.url}/api/sync/push`, token, {
        method: "POST",
        body: JSON.stringify({
          deviceId,
          clientVersion,
          operations: pending.map(remoteOperation),
        }),
      });
      if (!Array.isArray(pushed.results) || typeof pushed.cursor !== "string") {
        throw new Error("Team Server push response is invalid");
      }
      const byId = new Map(pending.map((operation) => [operation.id, operation]));
      const acknowledgedOperationIds = [];
      const entityBases = [];
      for (const result of pushed.results) {
        const operation = byId.get(result.operationId);
        if (!operation || !["accepted", "branch"].includes(result.status)) continue;
        acknowledgedOperationIds.push(operation.id);
        const base = acceptedBase(operation, result);
        if (base) entityBases.push(base);
        if (result.status === "branch") {
          const detail = await jsonRequest(
            remoteFetch,
            `${profile.url}/api/task-branches/${encodeURIComponent(result.branchId)}`,
            token,
          );
          const branch = detail.branch;
          await syncStore.recordBranch({
            id: `${profile.id}:${branch.id}`,
            profileId: profile.id,
            serverBranchId: branch.id,
            taskId: branch.taskId,
            baseRevision: branch.baseRevision,
            currentMainRevision: branch.currentMainRevision,
            proposedRevision: branch.proposedRevision,
            baseSnapshot: branch.baseSnapshot,
            mainSnapshot: branch.mainSnapshot,
            branchSnapshot: branch.branchSnapshot,
            authorId: branch.authorId,
            deviceId: branch.deviceId,
            canResolve: branch.canResolve,
            state: branch.state,
          });
        }
      }
      await syncStore.acknowledgeBatch(profile.id, {
        cursor: pushed.cursor,
        acknowledgedOperationIds,
        entityBases,
      });
      return {
        profileId: profile.id,
        status: "online",
        cursor: pushed.cursor,
        pendingOperations: (await syncStore.listPending(profile.id)).length,
      };
    } catch (error) {
      if (error.status === 401) {
        return setFailure(profile.id, "invalid_credentials", error, { pause: true });
      }
      return setFailure(profile.id, "offline", error);
    }
  }

  return {
    async start({ intervalMs = 30_000 } = {}) {
      stopped = false;
      const schedule = () => {
        if (stopped) return;
        reconnectTimer = setTimer(async () => {
          await this.syncNow();
          schedule();
        }, intervalMs);
        reconnectTimer?.unref?.();
      };
      const result = await this.syncNow();
      schedule();
      return result;
    },
    stop() {
      stopped = true;
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      reconnectTimer = null;
    },
    async syncNow(options = {}) {
      const profile = await activeProfile();
      if (!profile) return { status: "local", profileId: null, pendingOperations: 0 };
      const previous = queues.get(profile.id) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(() => run(profile, options));
      queues.set(profile.id, current);
      try {
        return await current;
      } finally {
        if (queues.get(profile.id) === current) queues.delete(profile.id);
      }
    },
    async status() {
      const profile = await activeProfile();
      if (!profile) return { status: "local", profileId: null, pendingOperations: 0 };
      await syncStore.upsertProfile({ id: profile.id, serverUrl: profile.url, active: true });
      const state = await syncStore.getSyncState(profile.id);
      return {
        ...state,
        pendingOperations: (await syncStore.listPending(profile.id)).length,
        branchCount: (await syncStore.listBranches(profile.id)).filter((branch) => branch.state === "open").length,
      };
    },
    async pause() {
      const profile = await activeProfile();
      if (!profile) return { status: "local", profileId: null };
      await syncStore.upsertProfile({ id: profile.id, serverUrl: profile.url, active: true });
      return syncStore.setSyncState(profile.id, { paused: true, status: "paused" });
    },
    async resume() {
      const profile = await activeProfile();
      if (!profile) return { status: "local", profileId: null };
      await syncStore.upsertProfile({ id: profile.id, serverUrl: profile.url, active: true });
      return syncStore.setSyncState(profile.id, {
        paused: false,
        status: "idle",
        retryCount: 0,
        nextRetryAt: null,
        lastError: null,
      });
    },
  };
}
