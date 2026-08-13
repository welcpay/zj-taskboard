# Windows and Linux Desktop Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build genuine unsigned Windows x64 MSI/NSIS and Linux x64 DEB/AppImage deliverables that install a verified, versioned Taskboard daemon on `127.0.0.1:47823`.

**Architecture:** Keep the existing macOS launcher intact behind a macOS compilation module. Add a portable desktop launcher that calls a Windows Task Scheduler or Linux systemd-user adapter, opens the locally verified Taskboard URL in the default browser, and never stops the daemon on ordinary exit. Make resource preparation target-aware so Tauri packages the matching Node runtime and a self-contained daemon runtime.

**Tech Stack:** Tauri 2, Rust 1.88, Node.js 22.23.2, Windows Task Scheduler, systemd user units, GitHub Actions native runners.

---

## File Map

- `test/cross-platform-delivery.test.mjs`: source contracts for platform targets, service lifecycle files, Tauri package settings, and native CI output assertions.
- `scripts/prepare-tauri-app.mjs`: target-aware Node archive retrieval, checksum validation, runtime copying, and platform taskctl wrappers.
- `src-tauri/src/main.rs`: small platform selector only.
- `src-tauri/src/macos.rs`: current macOS-only launcher implementation, kept behaviorally unchanged.
- `src-tauri/src/portable.rs`: Windows/Linux tray launcher, daemon reconciliation, default browser fallback, and explicit service removal command.
- `src-tauri/src/platform_daemon.rs`: versioned runtime installation, fixed-port health check, rollback, and platform-specific service activation.
- `src-tauri/tauri.conf.json`: cross-platform icon and bundle compatibility.
- `.github/workflows/package-windows-linux.yml`: native Windows/Linux build matrix and immutable workflow artifacts.
- `docs/superpowers/specs/2026-08-13-windows-linux-desktop-delivery-design.md`: approved product and platform constraints.

### Task 1: Lock the cross-platform delivery contract

**Files:**
- Create: `test/cross-platform-delivery.test.mjs`

- [ ] **Step 1: Write the failing source-contract test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const prepare = await readFile(new URL("../scripts/prepare-tauri-app.mjs", import.meta.url), "utf8");
const portable = await readFile(new URL("../src-tauri/src/portable.rs", import.meta.url), "utf8");
const daemon = await readFile(new URL("../src-tauri/src/platform_daemon.rs", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/package-windows-linux.yml", import.meta.url), "utf8");

test("Windows and Linux runtime preparation pins native Node archives", () => {
  assert.match(prepare, /x86_64-pc-windows-msvc/);
  assert.match(prepare, /x86_64-unknown-linux-gnu/);
  assert.match(prepare, /node-v22\.23\.2-win-x64\.zip/);
  assert.match(prepare, /node-v22\.23\.2-linux-x64\.tar\.xz/);
  assert.match(prepare, /node-x86_64-pc-windows-msvc\.exe/);
  assert.match(prepare, /node-x86_64-unknown-linux-gnu/);
});

test("the portable launcher uses browser fallback and never owns the HTTP service", () => {
  assert.match(portable, /http:\/\/127\.0\.0\.1:47823\//);
  assert.match(portable, /open_browser/);
  assert.match(portable, /uninstall_daemon/);
  assert.doesNotMatch(portable, /TcpListener/);
});

test("Windows and Linux daemon adapters keep versioned fixed-port services", () => {
  assert.match(daemon, /CodexTaskboard\\\\Daemon/);
  assert.match(daemon, /schtasks/);
  assert.match(daemon, /codex-taskboard-daemon\.service/);
  assert.match(daemon, /systemctl/);
  assert.match(daemon, /127\.0\.0\.1:47823/);
  assert.match(daemon, /rollback/);
  assert.match(daemon, /current\.json/);
});

test("native package CI builds every requested Windows and Linux installer", () => {
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /ubuntu-24\.04/);
  assert.match(workflow, /--bundles msi,nsis/);
  assert.match(workflow, /--bundles deb,appimage/);
  assert.match(workflow, /bundle\/msi/);
  assert.match(workflow, /bundle\/nsis/);
  assert.match(workflow, /bundle\/deb/);
  assert.match(workflow, /bundle\/appimage/);
});
```

- [ ] **Step 2: Verify the test fails because the implementation files do not exist**

Run: `node --test test/cross-platform-delivery.test.mjs`

Expected: failure reading `src-tauri/src/portable.rs` or `src-tauri/src/platform_daemon.rs`.

- [ ] **Step 3: Keep the test as the release behavior contract**

The test remains after implementation; no production code is written in this task.

- [ ] **Step 4: Commit the red test only after the expected failing result has been recorded**

```bash
git add test/cross-platform-delivery.test.mjs
git commit -m "test: define cross-platform delivery contracts"
```

### Task 2: Prepare authenticated native runtimes for Tauri

**Files:**
- Modify: `scripts/prepare-tauri-app.mjs`
- Modify: `package.json`
- Test: `test/cross-platform-delivery.test.mjs`

- [ ] **Step 1: Add the target table before changing resource preparation**

The table maps `x86_64-pc-windows-msvc` to `win-x64`, ZIP extraction, `node.exe`, `node-x86_64-pc-windows-msvc.exe`, and the checksum `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`. It maps `x86_64-unknown-linux-gnu` to `linux-x64`, tar.xz extraction, `node`, `node-x86_64-unknown-linux-gnu`, and checksum `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`.

- [ ] **Step 2: Run the contract test and confirm it still fails for missing portable service files**

Run: `node --test test/cross-platform-delivery.test.mjs`

Expected: the Node target assertions pass while the test still fails reading the non-existent portable source.

- [ ] **Step 3: Implement target-aware extraction and bundled runtime creation**

`prepare-tauri-app.mjs` must:

```js
const target = parseTarget(process.argv.slice(2));
const platform = targetPlatform(target);
const nodeBinaryName = platform === "windows" ? "node.exe" : "node";
const sidecarPath = path.join(binariesDirectory, `node-${target}${platform === "windows" ? ".exe" : ""}`);
```

It must copy the validated binary both to Tauri's target-specific sidecar path and to `resources/daemon-runtime/node` (or `node.exe`), copy server/shared/web/daemon assets, calculate the manifest after the binary is written, and write a `.cmd` wrapper on Windows, a POSIX shell wrapper on Linux, and the existing zsh wrapper on macOS.

- [ ] **Step 4: Add explicit package scripts**

```json
"app:build:windows": "npm run app:prepare -- --target x86_64-pc-windows-msvc && tauri build --bundles msi,nsis --config {\\\"bundle\\\":{\\\"createUpdaterArtifacts\\\":false}}",
"app:build:linux": "npm run app:prepare -- --target x86_64-unknown-linux-gnu && tauri build --bundles deb,appimage --config {\\\"bundle\\\":{\\\"createUpdaterArtifacts\\\":false}}"
```

- [ ] **Step 5: Re-run the focused test**

Run: `node --test test/cross-platform-delivery.test.mjs`

Expected: it advances past resource preparation assertions and still reports the intentionally absent portable service source.

- [ ] **Step 6: Commit resource preparation**

```bash
git add scripts/prepare-tauri-app.mjs package.json test/cross-platform-delivery.test.mjs
git commit -m "feat: prepare Windows and Linux Taskboard runtimes"
```

### Task 3: Add portable daemon adapters and browser launcher

**Files:**
- Create: `src-tauri/src/macos.rs`
- Create: `src-tauri/src/portable.rs`
- Create: `src-tauri/src/platform_daemon.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: `test/cross-platform-delivery.test.mjs`
- Test: `test/launcher-daemon.test.mjs`
- Test: `test/launcher-release.test.mjs`

- [ ] **Step 1: Move the existing macOS implementation without behavior changes**

Copy the existing `main.rs` body to `macos.rs`, change its final `fn main()` to `pub fn run()`, and use `#[path = "daemon.rs"] mod daemon;` inside `macos.rs`. Replace `main.rs` with:

```rust
#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(target_os = "macos"))]
mod platform_daemon;
#[cfg(not(target_os = "macos"))]
mod portable;

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    portable::run();
}
```

- [ ] **Step 2: Implement verified versioned runtime installation in `platform_daemon.rs`**

The module must define a `Layout` with `support`, `runtime`, `current_json`, `service_definition`, and `logs` paths. `reconcile_daemon()` must verify the bundled manifest, stop the currently registered service, stage and validate the runtime, record `{ "version": "<version>" }` in `current.json`, write the platform service definition pointing to `runtime/<version>`, activate it, and wait for `GET /health` to return product `codex-taskboard` with the selected daemon version. On an error after a prior version exists, it restores `current.json`, rewrites/reactivates the old service, and returns an error containing `rollback`.

Windows service XML must use a user task named `CodexTaskboard\\Daemon`, an interactive-logon trigger, and restart-on-failure. Linux must write `~/.config/systemd/user/codex-taskboard-daemon.service` with:

```ini
[Service]
ExecStart=<absolute runtime node> <absolute daemon entry> --host 127.0.0.1 --port 47823
Restart=on-failure
RestartSec=10
```

`uninstall_daemon()` must remove only the active platform service definition and runtime directory; it must not remove support-directory database or attachments.

- [ ] **Step 3: Implement the portable tray launcher**

`portable.rs` must call `platform_daemon::reconcile_daemon()` in `setup`, then call `open_browser("http://127.0.0.1:47823/")`. On Windows use `cmd /C start`; on Linux use `xdg-open`; propagate a clear error if the command cannot launch. Add tray actions for opening the browser, explicit service removal, and quitting. Ordinary quit only exits the launcher and must not call a service-stop path.

- [ ] **Step 4: Add the one portable dependency needed for recursive copy**

```toml
walkdir = "2"
```

Use `walkdir` to copy runtime files while preserving relative paths. Do not use Unix-only symbols outside `#[cfg(target_os = "macos")]` code.

- [ ] **Step 5: Update the macOS source-contract tests for the module split**

Tests that inspect macOS behavior must read `src-tauri/src/macos.rs`; they must continue asserting the existing launchd, CDP, private pipe, and no-daemon-on-exit behavior.

- [ ] **Step 6: Run tests and native compilation checks**

Run: `node --test test/cross-platform-delivery.test.mjs test/launcher-daemon.test.mjs test/launcher-release.test.mjs`

Expected: all source contracts pass.

Run: `/opt/homebrew/opt/rustup/bin/cargo check --manifest-path src-tauri/Cargo.toml`

Expected: macOS launcher compiles with the original implementation isolated in `macos.rs`.

- [ ] **Step 7: Commit the portable launcher**

```bash
git add src-tauri/src/main.rs src-tauri/src/macos.rs src-tauri/src/portable.rs src-tauri/src/platform_daemon.rs src-tauri/Cargo.toml src-tauri/Cargo.lock test/cross-platform-delivery.test.mjs test/launcher-daemon.test.mjs test/launcher-release.test.mjs
git commit -m "feat: add Windows and Linux daemon launchers"
```

### Task 4: Build native packages in CI

**Files:**
- Create: `.github/workflows/package-windows-linux.yml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `test/cross-platform-delivery.test.mjs`

- [ ] **Step 1: Add the native workflow matrix**

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - os: windows-latest
        target: x86_64-pc-windows-msvc
        bundles: msi,nsis
        output: windows-x64-unsigned
      - os: ubuntu-24.04
        target: x86_64-unknown-linux-gnu
        bundles: deb,appimage
        output: linux-x64-unsigned
```

Each job checks out source, installs Node 22 and Rust 1.88, runs `npm ci`, installs Linux build dependencies only on Linux, runs `npm run app:prepare -- --target <target>`, then runs `npm run tauri -- build --bundles <bundles> --config '{"bundle":{"createUpdaterArtifacts":false}}'`. The Windows job asserts `bundle/msi/*.msi` and `bundle/nsis/*.exe`; the Linux job asserts `bundle/deb/*.deb` and `bundle/appimage/*.AppImage`; then each uploads a versioned unsigned artifact with `actions/upload-artifact@v4`.

- [ ] **Step 2: Add Windows icon support without changing macOS icon inputs**

Generate `src-tauri/icons/icon.ico` from the existing PNG using the Tauri icon generator and include it in `bundle.icon` alongside the existing PNG/ICNS values.

- [ ] **Step 3: Run source contracts and repository tests**

Run: `node --test test/cross-platform-delivery.test.mjs test/launcher-daemon.test.mjs test/launcher-release.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: full Node suite exits zero.

Run: `npm run typecheck && npm run build:web`

Expected: both commands exit zero.

- [ ] **Step 4: Commit native build automation**

```bash
git add .github/workflows/package-windows-linux.yml src-tauri/tauri.conf.json src-tauri/icons/icon.ico test/cross-platform-delivery.test.mjs
git commit -m "ci: package Windows and Linux installers"
```

### Task 5: Publish and verify native workflow artifacts

**Files:**
- No new source files.

- [ ] **Step 1: Push the implementation branch to `zj/main`**

Run: `git push zj main`

Expected: GitHub receives the commits and starts the package workflow.

- [ ] **Step 2: Inspect each workflow job and artifact manifest**

Use GitHub Actions API or `gh run` to verify both native jobs conclude successfully and list the generated installer files. Do not describe an installer as delivered if its native job has not passed.

- [ ] **Step 3: Add a taskboard progress comment and move the issue to review**

The comment must list successful package names, workflow run URL, native platform scope, test/build evidence, and unsigned-code-signing limitations. Re-read `LOCAL7C17675-1` immediately before the status move and pass its version to `taskctl issue move ... --status in_review --if-version <version>`.
