#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed`);
}

export async function createLocalDmg({ version, appPath, outputPath }) {
  const stage = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-dmg-"));
  try {
    await cp(appPath, path.join(stage, "Codex Taskboard.app"), { recursive: true, force: true });
    await symlink("/Applications", path.join(stage, "Applications"));
    await mkdir(path.dirname(outputPath), { recursive: true });
    run("hdiutil", ["create", "-ov", "-format", "UDZO", "-volname", `Codex Taskboard ${version}`, "-srcfolder", stage, outputPath]);
    run("codesign", ["--force", "--sign", "-", outputPath]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const appPath = path.join(root, "src-tauri", "target", "universal-apple-darwin", "release", "bundle", "macos", "Codex Taskboard.app");
  const outputPath = path.join(root, "dist", `Codex Taskboard ${pkg.version}.dmg`);
  await createLocalDmg({ version: pkg.version, appPath, outputPath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
