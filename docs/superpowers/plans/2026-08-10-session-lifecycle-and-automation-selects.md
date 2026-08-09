# Taskboard Session Lifecycle and Automation Selects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a Taskboard-managed Codex session leaves no stale launcher/service after Codex exits, and make all automation choices reliably selectable inside the injected UI.

**Architecture:** Treat the packaged launcher, injector, server, and dedicated Codex process as one session: after the first successful renderer attachment, loss of the managed Codex browser ends the injector and launcher instead of recovering indefinitely. Replace native HTML selects with a focused React listbox component rendered inside the automation panel so macOS native popups cannot escape the injected document.

**Tech Stack:** Rust/Tauri 2, Node.js ESM, React 19, TypeScript, Node test runner, Vite.

---

### Task 1: End the injector when an attached managed Codex session closes

**Files:**
- Modify: `scripts/codex-injector.mjs`
- Modify: `scripts/codex-injector-runtime.mjs`
- Test: `test/injector-host-runtime.test.mjs`
- Test: `test/injector.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

Add a runtime helper test that distinguishes startup waiting from post-attachment disconnect:

```js
test("managed sessions exit after the attached Codex browser disconnects", () => {
  assert.equal(shouldEndManagedSession({ launched: true, attachedOnce: true, browserConnected: false }), true);
  assert.equal(shouldEndManagedSession({ launched: true, attachedOnce: false, browserConnected: false }), false);
  assert.equal(shouldEndManagedSession({ launched: false, attachedOnce: true, browserConnected: false }), false);
});
```

Add source-contract assertions that the watch loop records its first successful attachment and returns normally after the managed browser closes, rather than starting another launch cycle.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test test/injector-host-runtime.test.mjs test/injector.test.mjs
```

Expected: FAIL because `shouldEndManagedSession` and the post-attachment exit path do not exist.

- [ ] **Step 3: Implement the minimal session-end predicate**

Export a pure helper from `scripts/codex-injector-runtime.mjs`:

```js
export function shouldEndManagedSession({ launched, attachedOnce, browserConnected }) {
  return launched && attachedOnce && !browserConnected;
}
```

In `scripts/codex-injector.mjs`, track `attachedOnce` only after injection reports success. When the CDP pipe/browser closes, use the helper to exit the watch loop normally. Preserve the existing wait/retry behavior before the first successful attachment and for non-launcher `--watch` usage.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test test/injector-host-runtime.test.mjs test/injector.test.mjs
```

Expected: all focused tests PASS.

- [ ] **Step 5: Commit the injector lifecycle change**

```bash
git add scripts/codex-injector.mjs scripts/codex-injector-runtime.mjs test/injector-host-runtime.test.mjs test/injector.test.mjs
git commit -m "fix: end managed session when Codex exits"
```

### Task 2: Make the launcher clean up and exit instead of recovering a closed session

**Files:**
- Modify: `src-tauri/src/main.rs`
- Test: `test/launcher-release.test.mjs`

- [ ] **Step 1: Write failing launcher source-contract tests**

Add assertions covering three requirements:

```js
test("the packaged launcher exits after its managed session ends", () => {
  assert.match(launcherSource, /clear_pid_record\(&event_state, pid\)/);
  assert.match(launcherSource, /event_app\.exit\(0\)/);
  assert.doesNotMatch(launcherSource, /thread::sleep\(Duration::from_secs\(2\)\)[\s\S]*?start_launcher\(&event_app/);
});
```

Keep the existing assertions for exact PID command matching and process-group termination so cleanup cannot kill unrelated Codex processes.

- [ ] **Step 2: Run the launcher test and verify RED**

Run:

```bash
node --test test/launcher-release.test.mjs
```

Expected: FAIL because the child watcher still enters the automatic recovery branch.

- [ ] **Step 3: Replace recovery with deterministic shutdown**

In the child watcher in `src-tauri/src/main.rs`:

```rust
clear_pid_record(&event_state, pid);
update_snapshot(&event_app, &event_state, |snapshot| {
    snapshot.child_pid = None;
    snapshot.phase = "stopped".into();
    snapshot.message = "Codex 已退出，任务面板服务已停止。".into();
});
event_app.exit(0);
```

Remove only the delayed automatic `start_launcher` recovery path. Retain `RunEvent::ExitRequested` and `RunEvent::Exit` cleanup as an idempotent safety net, and retain `stop_recorded_child` before every new session.

- [ ] **Step 4: Run launcher and injector tests**

Run:

```bash
node --test test/launcher-release.test.mjs test/injector-host-runtime.test.mjs test/injector.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the launcher lifecycle change**

```bash
git add src-tauri/src/main.rs test/launcher-release.test.mjs
git commit -m "fix: stop Taskboard when managed Codex exits"
```

### Task 3: Add a reusable in-panel listbox

**Files:**
- Create: `web/src/components/AutomationSelect.tsx`
- Modify: `web/src/components/ProjectAutomationMenu.tsx`
- Modify: `web/src/styles.css`
- Test: `test/project-automation-settings.test.mjs`

- [ ] **Step 1: Write failing component-contract tests**

Extend `test/project-automation-settings.test.mjs` to read `AutomationSelect.tsx` and assert:

```js
test("automation choices use an in-panel accessible listbox", () => {
  assert.doesNotMatch(menuSource, /<select/);
  assert.equal((menuSource.match(/<AutomationSelect/g) ?? []).length, 3);
  assert.match(selectSource, /role="listbox"/);
  assert.match(selectSource, /role="option"/);
  assert.match(selectSource, /event\.key === "ArrowDown"/);
  assert.match(selectSource, /event\.key === "ArrowUp"/);
  assert.match(selectSource, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(selectSource, /event\.key === "Escape"/);
});
```

Update the prior native-select regression test to require the absence of native selects rather than focus-based suppression.

- [ ] **Step 2: Run the focused component test and verify RED**

Run:

```bash
node --test test/project-automation-settings.test.mjs
```

Expected: FAIL because `AutomationSelect.tsx` is absent and three native selects remain.

- [ ] **Step 3: Implement `AutomationSelect`**

Create a controlled component with this public interface:

```ts
interface AutomationSelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface AutomationSelectProps<T extends string | number> {
  ariaLabel: string;
  value: T;
  options: AutomationSelectOption<T>[];
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: T) => void;
}
```

Render a button plus an in-flow/absolutely positioned listbox inside a `.automation-select` wrapper. On ArrowDown/ArrowUp move the highlighted index, Enter/Space select, and Escape close without propagating to the parent dialog. Clicking an option calls `onChange`, then `onOpenChange(false)`.

- [ ] **Step 4: Replace all three native selects**

In `ProjectAutomationMenu.tsx`, maintain one field identifier:

```ts
type OpenSelect = "interval" | "model" | "effort" | null;
const [openSelect, setOpenSelect] = useState<OpenSelect>(null);
```

Use `AutomationSelect` for interval, model, and effort. Preserve current immediate submissions:

```tsx
onChange={(model) => submitChange(withAutomationModel(draft, model))}
```

When an option list is open, parent Escape handling closes that list first. Outside clicks close the list before they close the automation dialog.

- [ ] **Step 5: Add contained popup styling**

Add `.automation-select`, `.automation-select-trigger`, `.automation-select-listbox`, and `.automation-select-option` styles. Keep the list above sibling fields, constrained to the menu width, with selected/highlighted states using existing theme variables. Remove obsolete native-select focus rules.

- [ ] **Step 6: Run focused tests, typecheck, and build**

Run:

```bash
node --test test/project-automation-settings.test.mjs
npm run typecheck
npm run build:web
```

Expected: tests PASS, TypeScript emits no errors, and Vite build succeeds.

- [ ] **Step 7: Commit the listbox change**

```bash
git add web/src/components/AutomationSelect.tsx web/src/components/ProjectAutomationMenu.tsx web/src/styles.css test/project-automation-settings.test.mjs
git commit -m "fix: use stable automation listboxes"
```

### Task 4: Full verification, packaging, installation, and manual lifecycle check

**Files:**
- Verify all modified files
- Build: `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`
- Build: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/Codex Taskboard_0.2.0_universal.dmg`

- [ ] **Step 1: Run the complete automated verification**

```bash
npm test
npm run typecheck
npm run build:web
PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --target universal-apple-darwin
```

Expected: all tests PASS and both web and Rust checks succeed.

- [ ] **Step 2: Build the universal application**

```bash
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run app:build
```

Expected: the `.app` and `.dmg` bundles are created. A missing local Tauri updater private key may make the command exit after bundles are produced; verify bundle timestamps and contents before continuing.

- [ ] **Step 3: Ad-hoc sign and verify the local app**

Sign the launcher executable and outer app with the local ad-hoc identity while preserving the bundled Node signature, then run:

```bash
codesign --verify --deep --strict --verbose=2 "src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app"
```

Expected: `valid on disk` and `satisfies its Designated Requirement`.

- [ ] **Step 4: Stop the old session and replace the installed app safely**

Terminate only the recorded Taskboard launcher process group, wait for it to exit, move `/Applications/Codex Taskboard.app` to a timestamped backup in `~/.Trash`, copy the verified new app into `/Applications`, and open it.

- [ ] **Step 5: Verify startup and dropdown behavior**

Confirm `http://127.0.0.1:<assigned-port>/health` responds through the launcher runtime descriptor. Open 自动化, open each choice field, move the pointer across options, select a model, and verify the parent automation menu remains visible.

- [ ] **Step 6: Verify shutdown and clean reopen**

Quit the Taskboard-managed Codex window. Confirm the packaged launcher, injector, and server processes exit and their PID/runtime records are removed. Open `Codex Taskboard.app` again and confirm one fresh launcher/session starts and the taskboard renders.

- [ ] **Step 7: Record final artifacts**

Report the installed app path, DMG path, automated test results, and the observed clean-exit/reopen result. Do not commit generated bundles.
