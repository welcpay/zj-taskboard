# Immediate Run And Automation Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click task execution action and redesign the automation settings panel without creating duplicate Codex tasks or changing the persisted automation contract.

**Architecture:** `TaskCard` renders the action, while `App` owns optimistic status changes, thread creation requests, and rollback. The injected Codex bridge extends its existing composer-prefill request with a bounded `autoSubmit` flag and submits only after verifying the expected instruction. `ProjectAutomationMenu` keeps the same `AutomationOptions` payload and reorganizes controls into a segmented interval section plus compact model/effort fields.

**Tech Stack:** React 19, TypeScript, CSS, Node.js ESM, Chrome DevTools Protocol, Node test runner, Vite, Tauri.

---

### Task 1: Define Immediate-Run Eligibility And Card Action

**Files:**
- Modify: `web/src/components/TaskCard.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `test/board-interactions.test.mjs`

- [ ] **Step 1: Write the failing card contract tests**

Add assertions proving that `TaskCardProps` accepts `onRunNow`, that eligibility is limited to `todo` or unbound `in_progress`, and that the button stops propagation:

```js
assert.match(taskCardSource, /onRunNow\?: \(task: Task\) => void/);
assert.match(taskCardSource, /task\.status === "todo"[\s\S]*?task\.status === "in_progress"/);
assert.match(taskCardSource, /presentation\.conversations\.length === 0/);
assert.match(taskCardSource, /className="task-card-run-now"[\s\S]*?event\.stopPropagation\(\)[\s\S]*?onRunNow\?\(task\)/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/board-interactions.test.mjs`

Expected: FAIL because the card does not expose or render `onRunNow`.

- [ ] **Step 3: Implement the card action**

Extend the props and compute eligibility:

```tsx
onRunNow?: (task: Task) => void;
runNowPending?: boolean;

const canRunNow = variant === "main"
  && presentation.conversations.length === 0
  && (task.status === "todo" || task.status === "in_progress");
```

Render a stable footer with secondary detail and primary run actions. The primary button calls `event.stopPropagation()` and `onRunNow?.(task)`, and shows `正在启动...` while pending.

- [ ] **Step 4: Add restrained card styling**

Add `.task-card-actions`, `.task-card-detail-action`, and `.task-card-run-now` styles with 32px fixed height, 6px radius, visible focus state, and no layout shift between idle and pending labels.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `node --test test/board-interactions.test.mjs`

Expected: PASS.

### Task 2: Coordinate Status Change, Launch, And Rollback

**Files:**
- Modify: `web/src/App.tsx`
- Test: `test/board-interactions.test.mjs`
- Test: `test/inject.test.mjs`

- [ ] **Step 1: Write failing orchestration tests**

Assert the immediate-run flow has one pending task id, moves `todo` before launch, requests auto-submit, and rolls back only the status change it owns:

```js
assert.match(appSource, /const \[runningNowTaskId, setRunningNowTaskId\]/);
assert.match(appSource, /async function runTaskNow\(task: Task\)/);
assert.match(appSource, /task\.status === "todo"[\s\S]*?moveTaskRequest\(task, "in_progress"/);
assert.match(appSource, /openTaskInThread\(launchTask, \{ autoSubmit: true \}\)/);
assert.match(appSource, /moveTaskRequest\(current, "todo"/);
assert.match(appSource, /onRunNow=\{runTaskNow\}/);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/board-interactions.test.mjs test/inject.test.mjs`

Expected: FAIL because `runTaskNow` and `autoSubmit` do not exist.

- [ ] **Step 3: Make thread opening awaitable**

Change `openTaskInThread` to return `Promise<void>` and accept:

```ts
interface OpenTaskThreadOptions {
  autoSubmit?: boolean;
}
```

Include `autoSubmit` in the embedded `taskboard:create-thread` payload. Standalone mode keeps the current `codex://new` behavior and does not claim successful auto-submit.

- [ ] **Step 4: Implement `runTaskNow`**

Use a single `runningNowTaskId` guard. For `todo`, call `moveTaskRequest(task, "in_progress", task.sortOrder)` before opening the thread and update local state with the returned version. Await `openTaskInThread(launchTask, { autoSubmit: true })`.

On failure, if this call moved the task and the latest local task still matches that returned version and remains `in_progress` without conversations, call `moveTaskRequest(current, "todo", current.sortOrder)`. On a version conflict, refresh tasks instead of overwriting newer state. Always clear `runningNowTaskId`.

- [ ] **Step 5: Wire cards and verify GREEN**

Pass `onRunNow={runTaskNow}` and `runNowPending={runningNowTaskId === task.id}` to main cards. Run:

`node --test test/board-interactions.test.mjs test/inject.test.mjs`

Expected: PASS.

### Task 3: Auto-Submit The Verified Codex Composer

**Files:**
- Modify: `inject/codex-taskboard.user.js`
- Modify: `scripts/codex-injector-runtime.mjs`
- Modify: `scripts/codex-injector.mjs`
- Test: `test/inject.test.mjs`
- Test: `test/injector-host-runtime.test.mjs`
- Test: `test/injector.test.mjs`

- [ ] **Step 1: Write failing bridge tests**

Add assertions that only a boolean `autoSubmit` is accepted and forwarded, and that CDP dispatches Enter only after composer verification:

```js
assert.match(runtimeSource, /typeof request\.autoSubmit === "boolean"/);
assert.match(injectionSource, /requestHostTaskComposerPrefill\(\{ instruction, autoSubmit/);
assert.match(injectorSource, /if \(request\.autoSubmit\)[\s\S]*?Input\.dispatchKeyEvent/);
```

- [ ] **Step 2: Run bridge tests and verify RED**

Run: `node --test test/inject.test.mjs test/injector-host-runtime.test.mjs test/injector.test.mjs`

Expected: FAIL because the request schema and CDP action do not support auto-submit.

- [ ] **Step 3: Extend the narrow host schema**

For `prefill-task-composer`, accept `autoSubmit` only when absent or boolean. Forward it from `createThreadForTask` through `requestHostTaskComposerPrefill` without accepting any arbitrary keyboard command or selector.

- [ ] **Step 4: Submit only the verified instruction**

After `prefillTaskComposerViaCdp` verifies that the visible composer includes the exact instruction, dispatch Enter when `request.autoSubmit === true`:

```js
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
```

Then poll until the composer no longer contains the instruction or a running thread row appears. Throw a timeout error so `App` can roll back when submission did not start.

- [ ] **Step 5: Run bridge tests and verify GREEN**

Run: `node --test test/inject.test.mjs test/injector-host-runtime.test.mjs test/injector.test.mjs`

Expected: PASS.

### Task 4: Redesign The Automation Settings Panel

**Files:**
- Modify: `web/src/components/ProjectAutomationMenu.tsx`
- Modify: `web/src/styles.css`
- Test: `test/project-automation-settings.test.mjs`

- [ ] **Step 1: Write failing structure tests**

Assert that the panel has a summary header, segmented interval controls, a custom interval branch, a two-column model grid, and secondary quota settings:

```js
assert.match(menuSource, /project-automation-summary/);
assert.match(menuSource, /automation-interval-segments/);
for (const minutes of [5, 10, 15, 30, 60]) assert.match(menuSource, new RegExp(`>${minutes}<`));
assert.match(menuSource, /automation-model-grid/);
assert.match(menuSource, /project-automation-secondary/);
```

- [ ] **Step 2: Run the panel test and verify RED**

Run: `node --test test/project-automation-settings.test.mjs`

Expected: FAIL because the current panel is a flat list of fields.

- [ ] **Step 3: Implement the confirmed B layout**

Keep `submitChange` and `AutomationOptions` unchanged. Replace the interval select with buttons for `5`, `10`, `15`, `30`, `60`, and `其他`. Selecting a preset submits immediately. Selecting `其他` reveals the current bounded number input; `0` disables `enabledByUser`.

Place model and reasoning effort `AutomationSelect` controls in `.automation-model-grid`. Move quota-aware controls and quota status into `.project-automation-secondary` below the primary settings.

- [ ] **Step 4: Polish layout and popup behavior**

Set the panel width to 360px with a viewport-constrained maximum, 8px radius, 12–16px section padding, and full-width separators rather than nested cards. Ensure `.automation-select-listbox` has a higher stacking level than the panel and that closing remains controlled by outside click, selection, or Escape only.

- [ ] **Step 5: Run the panel test and verify GREEN**

Run: `node --test test/project-automation-settings.test.mjs`

Expected: PASS.

### Task 5: Verify, Release, And Produce Team Deliverables

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Regenerate: `dist/Codex Taskboard <version>.dmg`
- Regenerate: `dist/Codex Taskboard.zshrc`

- [ ] **Step 1: Run focused and complete verification**

Run:

```bash
node --test test/board-interactions.test.mjs test/inject.test.mjs test/injector-host-runtime.test.mjs test/injector.test.mjs test/project-automation-settings.test.mjs
npm test
npm run build:web
```

Expected: all tests pass; Vite build completes with only the existing chunk-size warning.

- [ ] **Step 2: Exercise the rendered UI**

Start the local service and verify at desktop and narrow viewport widths that card text does not overlap, the run button remains stable, interval segments wrap cleanly, and every automation select remains open while moving the pointer into its options.

- [ ] **Step 3: Publish the next patch version**

Create release notes covering immediate execution, rollback, duplicate protection, and the automation panel redesign. Run:

```bash
npm run app:release -- --yes --notes-file release-notes-<version>.md --allow-updater-key-error
```

Expected: package, Cargo, and Tauri versions increment together and a signed local DMG is created.

- [ ] **Step 4: Verify and install without data loss**

Mount the DMG and verify it contains `Codex Taskboard.app` plus the `/Applications` symlink. Run the local installer, which backs up `~/Library/Application Support/Codex Taskboard/`, then confirm before/after project and issue counts are not lower.

- [ ] **Step 5: Verify team deliverables**

Run `zsh -n 'dist/Codex Taskboard.zshrc'` and calculate SHA-256 checksums for the DMG and `.zshrc`. Report both clickable files and checksums.
