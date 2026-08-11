#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const dataDir = path.join(os.homedir(), "Library", "Application Support", "Codex Taskboard");
const databasePath = path.join(dataDir, "taskboard.sqlite");

export function readTaskboardCounts(filename = databasePath) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      projects: Number(db.prepare("SELECT COUNT(*) AS count FROM projects").get().count),
      issues: Number(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count),
    };
  } finally {
    db.close();
  }
}

async function sha256(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function backupData(version) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(dataDir, "backups", `before-${version}-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  const files = ["taskboard.sqlite", "taskboard.sqlite-wal", "taskboard.sqlite-shm", "codex-automation-policies.json"];
  const copied = [];
  for (const name of files) {
    const source = path.join(dataDir, name);
    try {
      await copyFile(source, path.join(backupDir, name));
      copied.push({ name, size: (await stat(source)).size });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const counts = readTaskboardCounts();
  await writeFile(path.join(backupDir, "backup-manifest.json"), `${JSON.stringify({ version, createdAt: new Date().toISOString(), counts, files: copied }, null, 2)}\n`);
  return { backupDir, counts };
}

async function main() {
  const versionIndex = process.argv.indexOf("--version");
  const version = versionIndex >= 0 ? process.argv[versionIndex + 1] : null;
  if (!version || !process.argv.includes("--yes")) throw new Error("Usage: install-local-release.mjs --version X.Y.Z --yes");
  const app = path.resolve(`src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`);
  const runtimePath = path.join(dataDir, "launcher-runtime.json");
  try {
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    if (Number.isInteger(runtime.pid)) {
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(runtime.pid)], { encoding: "utf8" }).trim());
      if (Number.isInteger(pgid) && pgid > 1) process.kill(-pgid, "SIGTERM");
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const snapshot = await backupData(version);
  const installed = "/Applications/Codex Taskboard.app";
  try {
    await rename(installed, path.join(os.homedir(), ".Trash", `Codex Taskboard.app.${Date.now()}`));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(app, installed, { recursive: true, force: true });
  const sourceLauncher = path.join(app, "Contents", "MacOS", "codex-taskboard-launcher");
  const installedLauncher = path.join(installed, "Contents", "MacOS", "codex-taskboard-launcher");
  if (await sha256(sourceLauncher) !== await sha256(installedLauncher)) {
    throw new Error("Installed Taskboard launcher does not match the release bundle");
  }
  spawnSync("open", ["-a", installed], { stdio: "inherit" });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const after = readTaskboardCounts();
  if (after.projects < snapshot.counts.projects || after.issues < snapshot.counts.issues) {
    throw new Error(`Historical data verification failed: ${JSON.stringify({ before: snapshot.counts, after })}`);
  }
  console.log(JSON.stringify({ version, backupDir: snapshot.backupDir, before: snapshot.counts, after }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
