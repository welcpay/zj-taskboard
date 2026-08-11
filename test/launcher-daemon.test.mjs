import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const daemonSource = await readFile(new URL("../src-tauri/src/daemon.rs", import.meta.url), "utf8");
const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

test("the desktop app reconciles a versioned launchd daemon on fixed port 47823", () => {
  assert.match(daemonSource, /com\.chuspeeism\.codex-taskboard\.daemon/);
  assert.match(daemonSource, /"bootstrap"/);
  assert.match(daemonSource, /"bootout"/);
  assert.match(daemonSource, /"kickstart"/);
  assert.match(daemonSource, /runtime-manifest\.json/);
  assert.match(daemonSource, /127\.0\.0\.1:47823/);
  assert.match(daemonSource, /daemonVersion/);
  assert.match(daemonSource, /rollback/);
  assert.match(daemonSource, /uninstall_daemon/);
  assert.match(launcherSource, /mod daemon;/);
  assert.match(launcherSource, /daemon::reconcile_daemon/);
  assert.match(launcherSource, /CODEX_TASKBOARD_URL", "http:\/\/127\.0\.0\.1:47823"/);
});

test("the desktop app no longer owns the HTTP listener or stops the daemon on exit", () => {
  assert.doesNotMatch(launcherSource, /TcpListener/);
  assert.doesNotMatch(launcherSource, /CODEX_TASKBOARD_LISTEN_FD/);
  assert.doesNotMatch(launcherSource, /taskboard_listener/);
  assert.doesNotMatch(launcherSource, /daemon::stop_daemon\([^)]*Exit/);
  assert.match(launcherSource, /stop_managed_child_locked/);
});

test("the tray exposes explicit service removal while ordinary exit leaves the daemon alone", () => {
  assert.match(launcherSource, /stop-and-uninstall-service/);
  assert.match(launcherSource, /停止并卸载本地服务/);
  assert.match(launcherSource, /daemon::uninstall_daemon/);
  assert.match(launcherSource, /不会删除任务、评论或附件/);
  assert.doesNotMatch(launcherSource, /"quit"[\s\S]{0,500}?daemon::uninstall_daemon/);
});
