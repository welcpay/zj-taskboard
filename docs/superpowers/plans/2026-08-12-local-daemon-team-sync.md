# Local Daemon and Team Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Codex Taskboard as a launchd-managed local-first service on `127.0.0.1:47823`, update it atomically, ship DMG and PKG artifacts, and synchronize offline task work with one active Team Server using task branches for concurrent edits.

**Architecture:** The desktop App installs a versioned daemon runtime under Application Support and manages a per-user LaunchAgent. Every local client talks only to the fixed local daemon. The daemon persists local operations in an outbox, pulls Team Server revisions before pushing, and turns incompatible concurrent edits into durable task branches.

**Tech Stack:** Node.js 22+, SQLite, React 19, TypeScript, Tauri 2/Rust, macOS launchd/Keychain, Cloudflare Worker/D1/R2, GitHub Actions.

---

## File Map

- `scripts/daemon-runtime.mjs`: runtime paths, manifests, LaunchAgent plist, atomic switching, health verification, rollback, and uninstall.
- `scripts/taskboard-daemon.mjs`: fixed-port daemon entrypoint and runtime metadata.
- `src-tauri/src/daemon.rs`: desktop commands that install, update, start, stop, and uninstall the daemon runtime.
- `server/team-config.mjs`: multiple Team Server profiles and active-profile isolation.
- `server/keychain.mjs`: per-profile access-token storage through macOS Keychain.
- `server/team-sync.mjs`: pull/rebase/push loop, outbox acknowledgement, retry state, and branch creation responses.
- `server/database.mjs`: local sync profile, cursor, base snapshot, outbox, and branch persistence.
- `cloud/migrations/0006_team_sync.sql`: users, tokens, revisions, operation receipts, and task branches.
- `cloud/src/index.mjs`: authenticated sync, branch, merge, and update-mirror endpoints.
- `web/src/components/TeamServerSettings.tsx`: profile, authentication, sync, and update-source controls.
- `web/src/components/TaskBranchResolver.tsx`: main/branch comparison, promotion, and three-way merge.
- `scripts/create-macos-pkg.mjs`: signed PKG payload and lifecycle scripts.
- `.github/workflows/release-macos.yml`: notarized DMG, PKG, updater, checksums, and release metadata.

### Task 1: Extract Versioned Daemon Runtime Lifecycle

**Files:**
- Create: `scripts/daemon-runtime.mjs`
- Create: `scripts/taskboard-daemon.mjs`
- Modify: `scripts/prepare-tauri-app.mjs`
- Test: `test/daemon-runtime.test.mjs`

- [ ] Write a runtime lifecycle test using a temporary home directory. Assert that `installRuntime()` stages files, verifies their manifest, atomically switches `runtime/current`, writes `com.chuspeeism.codex-taskboard.daemon.plist`, and returns rollback metadata.
- [ ] Run `node --test test/daemon-runtime.test.mjs` and verify it fails because `daemon-runtime.mjs` does not exist.
- [ ] Implement `runtimeLayout()`, `renderLaunchAgentPlist()`, `installRuntime()`, `activateRuntime()`, `rollbackRuntime()`, and `uninstallRuntime()` with explicit absolute paths and no shell string interpolation.
- [ ] Implement `taskboard-daemon.mjs` so it sets host `127.0.0.1`, port `47823`, data directory, version, and runtime generation before starting `server/index.mjs`.
- [ ] Package the daemon entrypoint, server, Node runtime, and a SHA-256 manifest in `prepare-tauri-app.mjs`.
- [ ] Re-run `node --test test/daemon-runtime.test.mjs` and verify all lifecycle assertions pass.
- [ ] Commit `scripts/daemon-runtime.mjs scripts/taskboard-daemon.mjs scripts/prepare-tauri-app.mjs test/daemon-runtime.test.mjs` with `feat: add versioned taskboard daemon runtime`.

### Task 2: Manage launchd from the Desktop App

**Files:**
- Create: `src-tauri/src/daemon.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/Entitlements.plist`
- Test: `test/launcher-daemon.test.mjs`

- [ ] Write source-contract tests that require the fixed LaunchAgent label, `launchctl bootstrap`, `bootout`, and `kickstart`, a health/version gate, rollback, and a service-uninstall command.
- [ ] Run `node --test test/launcher-daemon.test.mjs` and verify the contract fails against the current launcher.
- [ ] Implement a focused Rust daemon module that copies the packaged runtime to staging, validates the manifest, switches `current`, installs the user LaunchAgent, and waits for `/health` to return the packaged version.
- [ ] Replace launcher-owned listener/server startup with daemon reconciliation. Keep the Codex injector as a separately managed session that receives `CODEX_TASKBOARD_URL=http://127.0.0.1:47823`.
- [ ] Make Codex session exit stop only the injector/Codex process group. Keep the desktop App and daemon lifecycles independent.
- [ ] Implement update rollback and explicit uninstall without deleting task data.
- [ ] Run `node --test test/launcher-daemon.test.mjs test/launcher-release.test.mjs test/injector.test.mjs` and run Cargo check with the repository's Rust 1.88 toolchain.
- [ ] Commit the Rust lifecycle change with `feat: manage the local daemon through launchd`.

### Task 3: Use the Fixed Local Endpoint Everywhere

**Files:**
- Modify: `scripts/codex-injector.mjs`
- Modify: `scripts/taskboard-supervisor.mjs`
- Modify: `scripts/prepare-tauri-app.mjs`
- Modify: `cli/taskctl.mjs`
- Test: `test/injector.test.mjs`
- Test: `test/cli.test.mjs`

- [ ] Add failing tests proving the injector never starts `server/index.mjs`, every packaged client targets `127.0.0.1:47823`, and a Codex/CDP restart does not alter the service URL.
- [ ] Remove server ownership and random listener inheritance from the injector. Retain only authenticated panel bootstrap and Codex-native action bridging.
- [ ] Make the packaged `taskctl` wrapper use the fixed companion endpoint and remove dependence on `launcher-runtime.json` for ordinary requests.
- [ ] Verify the targeted injector and CLI tests pass.
- [ ] Commit with `refactor: separate codex injection from taskboard service`.

### Task 4: Add Multiple Team Server Profiles and Keychain Tokens

**Files:**
- Create: `server/team-config.mjs`
- Create: `server/keychain.mjs`
- Modify: `server/app.mjs`
- Modify: `cli/taskctl.mjs`
- Test: `test/team-config.test.mjs`

- [ ] Add failing tests for multiple saved HTTPS profiles, exactly one active profile, profile-specific workspace mappings and sync state, and token storage that never writes token bytes to the JSON config.
- [ ] Implement versioned profile configuration with stable profile IDs and atomic mode-0600 writes.
- [ ] Implement Keychain get/set/delete with `/usr/bin/security` argument arrays and a test-injected command runner.
- [ ] Add local-only profile list/create/update/activate/delete, login, logout, and connection-test APIs and matching `taskctl team` commands.
- [ ] Verify switching profiles preserves isolated cursor/outbox namespaces.
- [ ] Commit with `feat: add team server profiles and keychain auth`.

### Task 5: Persist Local Sync State and Outbox Operations

**Files:**
- Modify: `server/database.mjs`
- Create: `server/team-sync-store.mjs`
- Test: `test/team-sync-database.test.mjs`

- [ ] Add failing database tests for profile cursors, base snapshots, ordered outbox operations, idempotency keys, branch records, retry state, and transactional acknowledgement.
- [ ] Add local SQLite migrations for `team_profiles`, `team_sync_state`, `team_entity_bases`, `team_outbox`, and `task_branches`.
- [ ] Implement a store API that appends user mutations in the same transaction as the local change and removes operations only after cursor and acknowledgement persistence commits.
- [ ] Ensure local-only projects and machine paths remain local fields and are not serialized into remote operations.
- [ ] Run the database and existing server tests.
- [ ] Commit with `feat: persist local-first sync state`.

### Task 6: Add Team Server Sync and Task Branch APIs

**Files:**
- Create: `cloud/migrations/0006_team_sync.sql`
- Modify: `cloud/src/index.mjs`
- Test: `test/cloud-shared-worker.test.mjs`
- Test: `test/team-sync-api.test.mjs`

- [ ] Add failing Worker tests for bearer-token authentication, role claims, monotonic `pull(cursor)`, idempotent batched push, optimistic base versions, and branch creation on incompatible concurrent edits.
- [ ] Add D1 tables for users, hashed access tokens, entity revisions, operation receipts, task branches, branch revisions, and update artifacts.
- [ ] Implement `/api/sync/pull`, `/api/sync/push`, branch list/get/promote/merge endpoints, and update-manifest delivery.
- [ ] Enforce merge permissions for task assignee, creator, or project administrator.
- [ ] Implement append-only comment and attachment merging while turning conflicting edits/deletes into branch operations.
- [ ] Run Worker integration tests against the real Miniflare/D1 harness.
- [ ] Commit with `feat: add team sync and task branch protocol`.

### Task 7: Implement the Pull-Rebase-Push Worker

**Files:**
- Create: `server/team-sync.mjs`
- Modify: `server/app.mjs`
- Modify: `server/index.mjs`
- Test: `test/team-sync.test.mjs`

- [ ] Add failing tests for pull-before-push ordering, independent-task automatic rebase, durable offline outbox, idempotent retry, branch responses, profile isolation, invalid-token pause, and bounded exponential backoff.
- [ ] Implement one serialized sync queue per active profile and trigger it on daemon startup, local mutation, reconnect timer, and explicit sync request.
- [ ] Apply remote changes and local acknowledgements transactionally. Continue syncing unrelated operations when one task becomes a branch.
- [ ] Expose local sync status without leaking tokens.
- [ ] Run sync, server, and cloud companion tests.
- [ ] Commit with `feat: synchronize local work with team servers`.

### Task 8: Build Team Server and Branch UI

**Files:**
- Create: `web/src/components/TeamServerSettings.tsx`
- Create: `web/src/components/TaskBranchResolver.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/styles.css`
- Test: `test/team-server-ui.test.mjs`
- Test: `test/task-branch-ui.test.mjs`

- [ ] Add failing UI contract tests for saved profiles, one active server, Keychain-backed login, connection test, offline state, last sync, pending operations, branch counts, pause/resume/sync-now, and update source.
- [ ] Add a settings surface using the existing compact operational UI patterns and icon system.
- [ ] Add branch comparison with base/main/branch values and actions for keep-main, promote-branch, and editable three-way merge.
- [ ] Hide merge actions when the server reports insufficient permissions.
- [ ] Run typecheck, targeted UI tests, and production web build.
- [ ] Commit with `feat: add team sync and task branch controls`.

### Task 9: Produce PKG and Complete Automated Updates

**Files:**
- Create: `scripts/create-macos-pkg.mjs`
- Modify: `scripts/create-macos-updater.mjs`
- Modify: `scripts/release-app.mjs`
- Modify: `.github/workflows/release-macos.yml`
- Modify: `scripts/verify-macos-release.mjs`
- Test: `test/release-app.test.mjs`
- Test: `test/pkg-release.test.mjs`

- [ ] Add failing release tests requiring one version across DMG, PKG, updater, runtime manifest, checksums, and latest metadata.
- [ ] Build a component PKG whose preinstall stops the old LaunchAgent and whose postinstall launches the new App once to reconcile and health-check the runtime.
- [ ] Extend GitHub Actions to sign, notarize, staple, verify, and publish PKG alongside DMG and updater artifacts.
- [ ] Allow the updater to resolve a signed Team Server mirror manifest before GitHub while retaining signature verification.
- [ ] Extend release verification to mount/extract every artifact, compare manifests, verify Developer IDs, validate notarization, and exercise the packaged Node runtime.
- [ ] Commit with `build: publish pkg and daemon-aware updates`.

### Task 10: Remove Duplicate-App and Permission Regressions

**Files:**
- Modify: `scripts/install-local-release.mjs`
- Modify: `src-tauri/src/main.rs`
- Modify: `README.md`
- Test: `test/install-local-release.test.mjs`

- [ ] Add failing tests proving local installation does not leave a registered `.app` backup in Trash, does not use AppleScript to control itself, and preserves a recoverable non-App archive plus all Application Support data.
- [ ] Change local installation to stop the LaunchAgent, archive the previous App as a compressed backup outside LaunchServices discovery, replace the App, reconcile the daemon, and verify historical data counts.
- [ ] Document DMG first install, automatic updates, PKG deployment, full service removal, logs, and recovery.
- [ ] Commit with `fix: prevent duplicate app permission prompts`.

### Task 11: End-to-End Verification

**Files:**
- Create: `scripts/verify-daemon-lifecycle.mjs`
- Modify: `package.json`

- [ ] Build the unsigned local App and install it into a temporary application/runtime root.
- [ ] Verify launchd-equivalent start, fixed-port health, crash restart, Codex-independent lifetime, runtime switching, failed-health rollback, and service uninstall with an agent-runnable lifecycle harness.
- [ ] Start a local Team Server fixture, write offline changes, reconnect, verify automatic upload, create a same-task concurrent edit, verify branch creation, and resolve it through promotion and three-way merge.
- [ ] Run `npm run typecheck`, `npm run build:web`, the full Node test suite, Cargo check, packaged taskctl verification, App preflight, and release artifact verification available without production secrets.
- [ ] Record commands, results, and any environment-limited signing checks in `LOCAL7C17675-1` before moving the task to `in_review`.
- [ ] Commit the verification harness with `test: verify daemon and team sync lifecycle`.

