#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReleaseNotes } from "./release-notes.mjs";
import { createLocalDmg } from "./create-local-dmg.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid current version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function resolveReleaseVersion({ current, requested }) {
  const version = requested ?? nextPatchVersion(current);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  const parts = (value) => value.split(".").map(Number);
  const [a, b, c] = parts(current);
  const [x, y, z] = parts(version);
  if (x < a || (x === a && y < b) || (x === a && y === b && z < c)) {
    throw new Error(`Release version ${version} is older than ${current}`);
  }
  return version;
}

export function dmgFileName(version) {
  return `Codex Taskboard ${version}.dmg`;
}

export function artifactNames(version) {
  return {
    dmg: `Codex.Taskboard_${version}_macOS-universal.dmg`,
    pkg: `Codex.Taskboard_${version}_universal.pkg`,
    updater: `Codex.Taskboard_${version}_universal.app.tar.gz`,
    updaterSignature: `Codex.Taskboard_${version}_universal.app.tar.gz.sig`,
    latest: "latest.json",
    checksums: "release-assets.sha256",
    metadata: "release-metadata.json",
  };
}

export function localSignTargets(appPath) {
  return [
    path.join(appPath, "Contents", "MacOS", "codex-taskboard-launcher"),
    appPath,
  ];
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function replaceText(relativePath, pattern, replacement) {
  const filename = path.join(root, relativePath);
  const source = await readFile(filename, "utf8");
  if (!pattern.test(source)) throw new Error(`Version marker not found in ${relativePath}`);
  await writeFile(filename, source.replace(pattern, replacement));
}

function gitChanges() {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "app-v*"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return execFileSync("git", ["log", `${tag}..HEAD`, "--pretty=format:%s"], {
      cwd: root,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
  } catch {
    return ["更新 Codex Taskboard 功能与兼容性"];
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const version = resolveReleaseVersion({ current: pkg.version, requested: arg("--version") });
  const dryRun = process.argv.includes("--dry-run");
  const yes = process.argv.includes("--yes");
  const notesPath = arg("--notes-file");
  const targets = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"];
  console.log(JSON.stringify({ current: pkg.version, version, targets, dryRun }, null, 2));
  if (dryRun) return;
  if (!yes) throw new Error("Add --yes after reviewing the proposed release version");

  if (version !== pkg.version) {
    const npm = spawnSync("npm", ["version", version, "--no-git-tag-version"], { cwd: root, stdio: "inherit" });
    if (npm.status !== 0) process.exit(npm.status ?? 1);
  }
  await replaceText("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`);
  await replaceText("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${version}"`);

  const changes = notesPath
    ? (await readFile(path.resolve(notesPath), "utf8")).split("\n").filter((line) => /^[-*]\s+/.test(line))
    : gitChanges();
  const notes = renderReleaseNotes({ version, date: new Date().toISOString().slice(0, 10), changes });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", `Codex Taskboard ${version} 更新说明.md`), notes);

  const changelogPath = path.join(root, "CHANGELOG.md");
  let changelog = "# 更新日志\n\n";
  try { changelog = await readFile(changelogPath, "utf8"); } catch {}
  if (!changelog.includes(`# Codex Taskboard ${version}`)) {
    await writeFile(changelogPath, `${changelog.trim()}\n\n${notes}`);
  }

  const build = spawnSync("npm", ["run", "app:build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}` },
  });
  const appPath = path.join(root, "src-tauri", "target", "universal-apple-darwin", "release", "bundle", "macos", "Codex Taskboard.app");
  for (const target of localSignTargets(appPath)) {
    const signed = spawnSync("codesign", ["--force", "--sign", "-", target], { stdio: "inherit" });
    if (signed.status !== 0) process.exit(signed.status ?? 1);
  }
  const verified = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
  if (verified.status !== 0) process.exit(verified.status ?? 1);
  await createLocalDmg({
    version,
    appPath,
    outputPath: path.join(root, "dist", dmgFileName(version)),
  });
  if (build.status !== 0 && !process.argv.includes("--allow-updater-key-error")) process.exit(build.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
