# Windows and Linux Desktop Delivery Design

## Goal

Ship genuine x64 Windows and Linux installers for Codex Taskboard 0.2.9 without weakening the existing macOS release path. Each installed client must own a versioned local daemon on `127.0.0.1:47823`, preserve user data across upgrades, and have a safe browser fallback when an embeddable Codex desktop client is unavailable.

## Supported Deliverables

The first cross-platform release supports these host and CPU combinations:

| Platform | Architecture | Installers | Service manager |
| --- | --- | --- | --- |
| Windows 10/11 | x64 | MSI and NSIS EXE | Per-user Task Scheduler task |
| Linux with systemd user sessions | x64 | Debian DEB and AppImage | systemd user unit |

Windows ARM and Linux ARM are deliberately excluded from this release. They require matching bundled Node runtimes and native build runners; they can be added as a separate artifact matrix later.

All Windows and Linux artifacts are unsigned in this first delivery. Their names and release metadata must state that fact. Authenticode signing, Linux package repository signing, and Tauri updater archives remain separate release hardening work because no corresponding signing credentials are currently configured.

## Product Behavior

The daemon remains the sole local API and data owner:

```text
Taskboard launcher / browser fallback / taskctl
                     |
                     v
            http://127.0.0.1:47823
                     |
                     v
       versioned daemon runtime + local data
```

The packaged launcher installs the bundled runtime beneath the user data directory, verifies its SHA-256 manifest, starts the per-user service, and verifies `/health` reports the packaged daemon version. The long-running process never runs from the application bundle, so the application can be upgraded or removed without corrupting the live daemon.

The Windows and Linux launchers open the local browser at `http://127.0.0.1:47823/` after the health gate succeeds. macOS retains the existing Codex injection path. If a future Windows or Linux Codex desktop client exposes a compatible authenticated CDP integration, it can be added behind a platform-specific launcher adapter; this delivery must not claim embedded-Codex support where it cannot be tested on the native runner.

## Platform Service Lifecycle

### Windows

Use a user-scoped Task Scheduler task named `CodexTaskboard\\Daemon`. The task runs at logon, uses the runtime version selected by the launcher, and configures Task Scheduler restart-on-failure. It runs without elevation and does not create a machine-wide Windows service.

Data, logs, the runtime manifest, and task metadata live under `%LOCALAPPDATA%\\Codex Taskboard`. Runtime versions are copied into `runtime\\<version>`. A `current.json` record identifies the active version rather than a directory symlink, because Windows cannot safely replace directories that contain an active executable.

An upgrade stops the task, installs and verifies the new version, rewrites the task XML to its absolute runtime path, starts it, and checks `/health`. A failed health check restores the prior task definition and runtime record before reporting an error. Explicit service removal deletes the scheduled task and runtime directories but never deletes the SQLite database, attachments, Team Server profiles, or tokens.

### Linux

Use a per-user systemd unit named `codex-taskboard-daemon.service`. Its unit file lives at `~/.config/systemd/user/`; it uses `Restart=on-failure`, a ten-second restart delay, and `WantedBy=default.target`. The unit runs the selected versioned runtime, not the AppImage or DEB payload.

Data and runtimes live in `~/.local/share/Codex Taskboard`; operational logs are emitted to the user journal. An upgrade stops the unit, atomically writes the new unit file pointing to the new runtime, reloads the user manager, enables and starts the unit, and verifies `/health`. If the manager is not available, the launcher reports that a systemd user session is required instead of silently starting an unmanaged copy.

The daemon exists while the user systemd session exists. Enabling it after a complete logout requires the operating system's user-linger policy, which the installer must not change without the user's explicit system-administration approval.

## Bundled Resources

`scripts/prepare-tauri-app.mjs` becomes target-aware. It continues to produce the existing universal macOS resources and adds two x64 Node 22.23.2 inputs verified against pinned SHA-256 values:

- `node-v22.23.2-win-x64.zip` → `binaries/node-x86_64-pc-windows-msvc.exe` and `daemon-runtime/node.exe`.
- `node-v22.23.2-linux-x64.tar.xz` → `binaries/node-x86_64-unknown-linux-gnu` and `daemon-runtime/node`.

The daemon runtime contains the fixed-port entrypoint, server, shared code, built web assets, and an integrity manifest. Tauri's `externalBin` mapping selects the matching Node binary for the compilation target. Platform-specific `taskctl` wrappers set the same local endpoint and their platform-native user data path.

## Rust Launcher Boundaries

The macOS launcher must remain behaviorally unchanged. Its implementation moves behind `cfg(target_os = "macos")`; shared UI status, menu wiring, updater scheduling, resource discovery, and health parsing remain in portable code.

Windows and Linux each receive a focused service adapter. The portable launcher uses that adapter to reconcile the daemon, open the local browser, and remove the service. No Windows or Linux module may import Unix-only process-group, file-descriptor, symlink, `launchctl`, or macOS application path APIs.

## Tauri Bundling and CI

The Tauri configuration declares an `.ico` asset in addition to existing PNG and ICNS icons, and supports explicit platform bundle overrides:

- Windows: `tauri build --bundles msi,nsis` on `windows-latest`.
- Linux: `tauri build --bundles deb,appimage` on `ubuntu-24.04` with the required WebKitGTK, appindicator, SVG, and packaging dependencies.

`prepare-tauri-app.mjs` and Tauri build run on the same native runner. The CI workflow uses a Windows/Linux matrix, installs Node 22 and Rust 1.88, verifies version alignment, builds the web application, prepares the correct runtime, builds with `createUpdaterArtifacts=false`, asserts every expected package exists, and uploads artifacts with an immutable versioned name. It runs on pushes to `main` and may be dispatched manually for a selected ref.

No workflow creates or mutates a GitHub Release. That remains the responsibility of the existing signed macOS tag workflow, which avoids race conditions and avoids publishing unsigned files as trusted automatic-update assets.

## Verification

Source-contract tests cover:

- supported target triples, archive checksums, output Node binary names, and platform wrappers;
- Windows Task Scheduler XML, rollback sequencing, data preservation, and fixed loopback endpoint;
- Linux systemd unit, rollback sequencing, systemd-user-manager failure reporting, data preservation, and fixed loopback endpoint;
- Tauri icon and bundle settings plus a CI matrix that invokes native MSI, NSIS, DEB, and AppImage builds.

Native CI validates actual installer output. Local macOS validation continues to run the Node test suite, typecheck, production web build, and existing macOS packaging checks. A native runner is the source of truth for Windows and Linux package usability.

## Acceptance Criteria

- Windows CI uploads a 0.2.9 x64 MSI and NSIS EXE built from the repository source.
- Linux CI uploads a 0.2.9 x64 DEB and AppImage built from the repository source.
- Every packaged runtime listens only on `127.0.0.1:47823`, reports its version in `/health`, and preserves user data on replacement.
- Windows upgrades replace only the scheduled task/runtime and Linux upgrades replace only the systemd unit/runtime; neither path removes user data.
- Closing a launcher does not intentionally stop either daemon.
- The existing macOS launchd, injection, DMG, PKG, updater, signing, and notarization paths retain their current behavior.
- In an unavailable native Codex integration environment, the launcher opens the Taskboard browser fallback instead of claiming injection succeeded.
