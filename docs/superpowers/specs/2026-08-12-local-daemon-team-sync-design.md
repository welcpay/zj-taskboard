# Local Daemon and Team Sync Design

## Goal

Make Codex Taskboard a reliable local-first client/server system. A launchd-managed daemon must keep `127.0.0.1:47823` available independently of Codex and the desktop App, survive crashes, update atomically, support offline work, and synchronize with one active Team Server without losing concurrent task changes.

## Scope

This design includes:

- A versioned local daemon managed by launchd.
- A fixed local client endpoint at `http://127.0.0.1:47823`.
- Separation of the HTTP daemon from the Codex injector and desktop App.
- Automatic in-App updates after the initial DMG installation.
- Signed and notarized DMG, PKG, and updater artifacts built by GitHub Actions.
- Team Server profiles, per-user tokens, local caching, offline writes, and background synchronization.
- Task branches for concurrent edits, including promotion and three-way merge.
- Team Server distribution of internal update mirrors.

GitLab CI/CD receives a stable integration boundary and event model, but a real GitLab connector is outside this implementation.

## Runtime Architecture

All local clients connect only to `127.0.0.1:47823`:

- The embedded Taskboard panel.
- `taskctl`.
- The Codex injector.
- The desktop App.

The local daemon owns the SQLite database, attachments, local API, synchronization worker, update status, and Team Server connections. The Codex injector only launches or attaches to Codex, installs the panel, and forwards native Codex actions. Closing Codex or the desktop App must not stop the daemon.

The daemon runtime is copied out of the App Bundle into a versioned directory:

```text
~/Library/Application Support/Codex Taskboard/
  runtime/
    current -> 0.3.0/
    0.3.0/
      node
      app/
  taskboard.sqlite
  attachments/
  daemon.json
```

No long-running process executes from `/Applications/Codex Taskboard.app`. The App can therefore be overwritten or deleted while the daemon is running.

## launchd Lifecycle

The per-user LaunchAgent label is `com.chuspeeism.codex-taskboard.daemon`. Its plist lives in `~/Library/LaunchAgents/` and launches `runtime/current` with:

- `RunAtLoad` enabled.
- `KeepAlive` enabled for unexpected exits.
- A bounded restart throttle to avoid CPU-heavy crash loops.
- Standard output and error under `~/Library/Logs/Codex Taskboard/`.
- Host `127.0.0.1` and port `47823`.

The daemon health response identifies the product, daemon version, runtime path, PID, and generation. If an unknown process owns `47823`, Taskboard reports the owner and does not terminate it.

The App provides a complete service removal action that stops and removes the LaunchAgent, plist, and runtime directories. It does not delete task data unless the user explicitly selects data removal.

## Installation and Updates

The initial user installation uses a signed and notarized DMG. All routine updates use the in-App updater. A signed and notarized PKG is also produced for offline, intranet, MDM, USB, or operations-managed installation.

GitHub Actions produces the following artifacts from one version and one signed App payload:

- DMG.
- PKG.
- App updater archive and signature.
- Update manifest.
- Checksums and release metadata.

The first launch of a new App performs an atomic daemon update:

1. Copy the bundled runtime into a staging directory.
2. Verify its manifest, signature, and version.
3. Rename staging to the final version directory.
4. Stop the LaunchAgent without allowing KeepAlive to race the update.
5. Atomically switch `runtime/current` to the new directory.
6. Install or refresh the plist and start the LaunchAgent.
7. Verify the `47823` health response reports the expected version.
8. Remove superseded runtimes only after the health check succeeds.

If any post-switch step fails, the updater restores the previous `current` target, restarts the old daemon, and retains diagnostics. App updates use a stable Developer ID and notarization identity so macOS does not treat each version as a new Documents or Automation permission subject. Installers do not leave old App bundles registered in Trash.

The default update feed is GitHub Releases. An active Team Server can mirror the update manifest and artifacts. Clients prefer the active Team Server mirror and fall back to GitHub when allowed. Every source uses the same signed artifacts and checksums.

## Team Server Profiles and Authentication

Users may save multiple Team Server profiles, but exactly one profile can be active. Each profile stores:

- HTTPS server URL.
- Non-secret server and organization metadata.
- Sync cursor and status.
- Update mirror capability.

Each user authenticates with an individual access token stored only in macOS Keychain. Shared team passwords are not used. Team Server operations retain the user identity needed for audit history and branch permissions. The initial authentication model can later be extended to SSO or OIDC without changing task ownership semantics.

Switching the active Team Server pauses the old profile's synchronization and keeps its cursor, outbox, and cached remote namespace isolated. Data and pending operations must never cross server profiles.

## Local-First Synchronization

The local daemon remains the only read/write endpoint even when a Team Server is configured. Users can continue creating, editing, commenting, attaching files, and moving tasks while offline.

Each locally generated operation records:

- Active Team Server profile.
- User and device identity.
- Entity identifier.
- Remote base version.
- Base snapshot needed for comparison.
- Ordered local change.
- Creation time and retry state.

The synchronization cycle is:

1. Pull remote changes after the profile's monotonic cursor.
2. Apply non-conflicting remote changes to the local cache.
3. Rebase independent local operations on the pulled state.
4. Push local operations with their base versions.
5. Persist the returned cursor and acknowledgements transactionally.
6. Remove acknowledged outbox operations only after the transaction commits.

Network failures use bounded exponential backoff. Offline state, invalid credentials, incompatible server versions, and merge branches are distinct states. A conflict on one task does not stop other tasks from synchronizing.

## Task Branches

When local and remote changes share a base but cannot be applied directly, the Team Server preserves the remote main task and uploads the local result as a task branch. A branch records:

- Common base revision and snapshot.
- Current main revision.
- Proposed branch revision.
- Author, device, timestamps, and audit history.
- Branch state and resolution.

The resolution UI shows field differences and supports:

- Keeping the main task unchanged.
- Promoting the branch as the new main revision.
- Three-way merging base, main, and branch into an editable final revision.

All members can create branches and submit merge proposals. The task assignee, task creator, and project administrators can promote or merge a branch. Resolution creates a new main revision and closes the branch without deleting its history.

Comments and attachments are append-only for ordinary synchronization. Conflicting edits or deletions of an existing comment or attachment metadata create a reviewable branch operation rather than silently overwriting remote state.

## Team Server Responsibilities

The Team Server provides:

- Users, tokens, roles, projects, and membership.
- Canonical project, task, comment, attachment, revision, and branch storage.
- A monotonic global change sequence for incremental pull.
- Batched push with optimistic base-version checks.
- Branch comparison, promotion, merge, and audit APIs.
- Client/server compatibility checks.
- Signed update mirror metadata and artifact delivery.

The protocol exposes two primary synchronization operations:

- `pull(cursor)` returns ordered changes and a new cursor.
- `push(operations, baseVersions)` acknowledges accepted operations or returns created branch IDs.

The future GitLab integration consumes and produces versioned Team Server events through a separate adapter boundary. It does not run inside the local synchronization core.

## Client Configuration and Status

The Taskboard settings UI exposes:

- Saved Team Server profiles and the active profile.
- Server URL and Keychain-backed token entry.
- Connection test, current user, role, and server version.
- Online or offline state and last successful synchronization.
- Pending upload and task branch counts.
- Pause, resume, and synchronize-now actions.
- Current update source and artifact version.
- Stop and uninstall local service action.

Without an active Team Server, Taskboard is fully local. With an active server, loss of connectivity does not block local work. An invalid token pauses synchronization and requests reauthentication.

## Failure Handling and Observability

- launchd restarts a crashed daemon and throttles repeated failures.
- The injector reconnects to the fixed local endpoint after Codex or CDP restarts.
- Unknown `47823` ownership is reported without killing the owner.
- Update failures roll back the runtime pointer and daemon.
- Team Server failures preserve the outbox and retry later.
- Conflict branches are durable workflow state, not transient retry errors.
- Logs record version, PID, runtime generation, update transitions, sync cursors, retry summaries, and branch creation without logging tokens.
- Logs rotate by size under `~/Library/Logs/Codex Taskboard/`.

## Acceptance Criteria

- Killing the daemon causes `47823` to recover automatically.
- Closing Codex and the desktop App does not stop `47823`.
- The App Bundle can be overwritten or deleted while the daemon runs.
- A new version switches daemon runtimes automatically and rolls back on failed health checks.
- GitHub Actions produces signed and notarized DMG, PKG, and updater artifacts.
- A Team Server mirror can update clients that cannot reach GitHub.
- Offline local writes synchronize after reconnection without manual replay.
- Concurrent task edits create branches instead of overwriting main.
- Unrelated tasks continue synchronizing while branches await resolution.
- Only the assignee, creator, or project administrator can promote or merge.
- Multiple saved Team Server profiles remain isolated and only one is active.
- Stable signing and removal of duplicate old App bundles prevent repeated Documents and self-Automation prompts across upgrades.

