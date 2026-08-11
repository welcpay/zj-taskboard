const LOCAL_ONLY_FIELDS = new Set([
  "workspacePath",
  "worktreePath",
  "worktreeBranch",
  "developmentContext",
]);

function parseJson(value) {
  return value === null ? null : JSON.parse(value);
}

function remoteValue(value) {
  if (Array.isArray(value)) return value.map(remoteValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
    LOCAL_ONLY_FIELDS.has(key) ? [] : [[key, remoteValue(entry)]]
  )));
}

function syncStateFromRow(row) {
  return {
    profileId: row.profile_id,
    cursor: row.cursor,
    status: row.status,
    paused: Boolean(row.paused),
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    lastError: row.last_error,
  };
}

function operationFromRow(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    idempotencyKey: row.idempotency_key,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operationType: row.operation_type,
    baseVersion: row.base_version,
    baseSnapshot: parseJson(row.base_snapshot),
    change: parseJson(row.change_json),
    userId: row.user_id,
    deviceId: row.device_id,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function branchFromRow(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    serverBranchId: row.server_branch_id,
    taskId: row.task_id,
    baseRevision: row.base_revision,
    currentMainRevision: row.current_main_revision,
    proposedRevision: row.proposed_revision,
    baseSnapshot: parseJson(row.base_snapshot),
    mainSnapshot: parseJson(row.main_snapshot),
    branchSnapshot: parseJson(row.branch_snapshot),
    authorId: row.author_id,
    deviceId: row.device_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTeamSyncStore({ database, now = () => new Date().toISOString() }) {
  const raw = database?.database ?? database;
  if (!raw?.prepare || !raw?.exec) throw new TypeError("A Taskboard SQLite database is required");

  function transaction(operation) {
    raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      raw.exec("COMMIT");
      return result;
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
  }

  function requireProfile(profileId) {
    if (!raw.prepare("SELECT 1 FROM team_profiles WHERE id = ?").get(profileId)) {
      throw new Error(`Team sync profile '${profileId}' does not exist`);
    }
  }

  function saveEntityBase(profileId, input, timestamp = now()) {
    requireProfile(profileId);
    raw.prepare(`
      INSERT INTO team_entity_bases (
        profile_id, entity_type, entity_id, remote_version, snapshot, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, entity_type, entity_id) DO UPDATE SET
        remote_version = excluded.remote_version,
        snapshot = excluded.snapshot,
        updated_at = excluded.updated_at
    `).run(
      profileId,
      input.entityType,
      input.entityId,
      input.remoteVersion,
      input.snapshot === null ? null : JSON.stringify(remoteValue(input.snapshot)),
      timestamp,
    );
  }

  return {
    async upsertProfile(input) {
      const timestamp = now();
      transaction(() => {
        if (input.active) raw.prepare("UPDATE team_profiles SET active = 0, updated_at = ? WHERE active = 1").run(timestamp);
        raw.prepare(`
          INSERT INTO team_profiles (id, server_url, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            server_url = excluded.server_url,
            active = excluded.active,
            updated_at = excluded.updated_at
        `).run(input.id, input.serverUrl, input.active ? 1 : 0, timestamp, timestamp);
        raw.prepare(`
          INSERT INTO team_sync_state (profile_id, updated_at)
          VALUES (?, ?)
          ON CONFLICT(profile_id) DO NOTHING
        `).run(input.id, timestamp);
      });
    },

    async getSyncState(profileId) {
      const row = raw.prepare("SELECT * FROM team_sync_state WHERE profile_id = ?").get(profileId);
      return row ? syncStateFromRow(row) : null;
    },

    async setSyncState(profileId, changes) {
      requireProfile(profileId);
      const current = await this.getSyncState(profileId);
      const next = { ...current, ...changes };
      raw.prepare(`
        UPDATE team_sync_state SET
          cursor = ?, status = ?, paused = ?, retry_count = ?, next_retry_at = ?,
          last_successful_sync_at = ?, last_error = ?, updated_at = ?
        WHERE profile_id = ?
      `).run(
        String(next.cursor),
        next.status,
        next.paused ? 1 : 0,
        next.retryCount,
        next.nextRetryAt,
        next.lastSuccessfulSyncAt,
        next.lastError,
        now(),
        profileId,
      );
      return this.getSyncState(profileId);
    },

    async saveEntityBase(profileId, input) {
      saveEntityBase(profileId, input);
      return this.getEntityBase(profileId, input.entityType, input.entityId);
    },

    async getEntityBase(profileId, entityType, entityId) {
      const row = raw.prepare(`
        SELECT * FROM team_entity_bases
        WHERE profile_id = ? AND entity_type = ? AND entity_id = ?
      `).get(profileId, entityType, entityId);
      return row ? {
        profileId: row.profile_id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        remoteVersion: row.remote_version,
        snapshot: parseJson(row.snapshot),
        updatedAt: row.updated_at,
      } : null;
    },

    async appendOperation(input, { applyLocal } = {}) {
      return transaction(() => {
        requireProfile(input.profileId);
        const existing = raw.prepare(`
          SELECT * FROM team_outbox WHERE profile_id = ? AND idempotency_key = ?
        `).get(input.profileId, input.idempotencyKey);
        if (existing) return operationFromRow(existing);
        if (applyLocal) applyLocal(raw);
        raw.prepare(`
          INSERT INTO team_outbox (
            id, profile_id, idempotency_key, entity_type, entity_id, operation_type,
            base_version, base_snapshot, change_json, user_id, device_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.profileId,
          input.idempotencyKey,
          input.entityType,
          input.entityId,
          input.operationType,
          input.baseVersion,
          input.baseSnapshot === null ? null : JSON.stringify(remoteValue(input.baseSnapshot)),
          JSON.stringify(remoteValue(input.change)),
          input.userId,
          input.deviceId,
          now(),
        );
        return operationFromRow(raw.prepare("SELECT * FROM team_outbox WHERE id = ?").get(input.id));
      });
    },

    async listPending(profileId) {
      return raw.prepare(`
        SELECT * FROM team_outbox
        WHERE profile_id = ?
        ORDER BY created_at, rowid
      `).all(profileId).map(operationFromRow);
    },

    async markRetry(profileId, operationId, input) {
      requireProfile(profileId);
      const result = raw.prepare(`
        UPDATE team_outbox
        SET retry_count = ?, next_retry_at = ?, last_error = ?
        WHERE profile_id = ? AND id = ?
      `).run(input.retryCount, input.nextRetryAt, input.error, profileId, operationId);
      if (result.changes !== 1) throw new Error(`Outbox operation '${operationId}' does not exist`);
    },

    async rebaseOperation(profileId, operationId, input) {
      requireProfile(profileId);
      const result = raw.prepare(`
        UPDATE team_outbox
        SET base_version = ?, base_snapshot = ?
        WHERE profile_id = ? AND id = ?
      `).run(
        input.baseVersion,
        input.baseSnapshot === null ? null : JSON.stringify(remoteValue(input.baseSnapshot)),
        profileId,
        operationId,
      );
      if (result.changes !== 1) throw new Error(`Outbox operation '${operationId}' does not exist`);
    },

    async acknowledgeBatch(profileId, input) {
      transaction(() => {
        requireProfile(profileId);
        for (const operationId of input.acknowledgedOperationIds) {
          if (!raw.prepare("SELECT 1 FROM team_outbox WHERE profile_id = ? AND id = ?").get(profileId, operationId)) {
            throw new Error(`Outbox operation '${operationId}' is missing`);
          }
        }
        const timestamp = now();
        for (const entityBase of input.entityBases) saveEntityBase(profileId, entityBase, timestamp);
        raw.prepare(`
          UPDATE team_sync_state
          SET cursor = ?, status = 'online', retry_count = 0, next_retry_at = NULL,
              last_error = NULL, last_successful_sync_at = ?, updated_at = ?
          WHERE profile_id = ?
        `).run(String(input.cursor), timestamp, timestamp, profileId);
        for (const operationId of input.acknowledgedOperationIds) {
          raw.prepare("DELETE FROM team_outbox WHERE profile_id = ? AND id = ?").run(profileId, operationId);
        }
      });
    },

    async recordBranch(input) {
      const timestamp = now();
      requireProfile(input.profileId);
      raw.prepare(`
        INSERT INTO task_branches (
          id, profile_id, server_branch_id, task_id, base_revision,
          current_main_revision, proposed_revision, base_snapshot, main_snapshot,
          branch_snapshot, author_id, device_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          server_branch_id = excluded.server_branch_id,
          current_main_revision = excluded.current_main_revision,
          proposed_revision = excluded.proposed_revision,
          main_snapshot = excluded.main_snapshot,
          branch_snapshot = excluded.branch_snapshot,
          state = excluded.state,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.profileId,
        input.serverBranchId ?? null,
        input.taskId,
        input.baseRevision,
        input.currentMainRevision,
        input.proposedRevision,
        JSON.stringify(remoteValue(input.baseSnapshot)),
        JSON.stringify(remoteValue(input.mainSnapshot)),
        JSON.stringify(remoteValue(input.branchSnapshot)),
        input.authorId,
        input.deviceId,
        input.state ?? "open",
        timestamp,
        timestamp,
      );
      return branchFromRow(raw.prepare("SELECT * FROM task_branches WHERE id = ?").get(input.id));
    },

    async listBranches(profileId) {
      return raw.prepare(`
        SELECT * FROM task_branches
        WHERE profile_id = ?
        ORDER BY created_at, id
      `).all(profileId).map(branchFromRow);
    },
  };
}
