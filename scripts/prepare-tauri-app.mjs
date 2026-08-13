#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const nodeVersion = "22.23.2";
const targets = {
  "aarch64-apple-darwin": { platform: "macos", architecture: "arm64" },
  "x86_64-apple-darwin": { platform: "macos", architecture: "x64" },
  "universal-apple-darwin": { platform: "macos", architecture: "universal" },
  "x86_64-pc-windows-msvc": {
    platform: "windows",
    archive: "node-v22.23.2-win-x64.zip",
    archiveRoot: "node-v22.23.2-win-x64",
    executable: "node.exe",
    binaryPath: "node.exe",
    sidecar: "node-x86_64-pc-windows-msvc.exe",
    checksum: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  },
  "x86_64-unknown-linux-gnu": {
    platform: "linux",
    archive: "node-v22.23.2-linux-x64.tar.xz",
    archiveRoot: "node-v22.23.2-linux-x64",
    executable: "node",
    binaryPath: "bin/node",
    sidecar: "node-x86_64-unknown-linux-gnu",
    checksum: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
  },
};
const macChecksums = {
  arm64: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  x64: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
};
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const binariesDirectory = path.join(tauriRoot, "binaries");
const resourcesDirectory = path.join(tauriRoot, "resources");
const runtimeCacheDirectory = path.join(projectRoot, "dist", "tauri-runtime-cache");
const extractionDirectory = path.join(runtimeCacheDirectory, "extracted");
const target = parseTarget(process.argv.slice(2));
const configuration = targets[target];

function parseTarget(argv) {
  let selected = "universal-apple-darwin";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--target") selected = argv[++index];
    else throw new Error("Unknown option: " + argv[index]);
  }
  if (!targets[selected]) throw new Error("Unsupported Tauri target: " + selected);
  return selected;
}

function requireNativeHost(platform) {
  const expected = { macos: "darwin", windows: "win32", linux: "linux" }[platform];
  if (process.platform !== expected) {
    throw new Error("Target " + target + " must be prepared on its native " + platform + " runner");
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || command + " exited with " + result.status);
  return result.stdout.trim();
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Download failed: " + response.status + " " + url);
  const temporary = destination + ".download";
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  await rename(temporary, destination);
}

async function verifiedArchive(archive, checksum) {
  const archivePath = path.join(runtimeCacheDirectory, archive);
  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== checksum) {
    await rm(archivePath, { force: true });
    await download("https://nodejs.org/dist/v" + nodeVersion + "/" + archive, archivePath);
  }
  if ((await sha256(archivePath)) !== checksum) throw new Error("Checksum verification failed for " + archive);
  return archivePath;
}

async function extractNode({ archive, archiveRoot, checksum, extractionName }) {
  const archivePath = await verifiedArchive(archive, checksum);
  const destination = path.join(extractionDirectory, extractionName);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("tar", ["-xf", archivePath, "-C", destination]);
  return path.join(destination, archiveRoot);
}

async function prepareMacNode() {
  const runtimes = new Map();
  for (const architecture of ["arm64", "x64"]) {
    runtimes.set(architecture, await extractNode({
      archive: "node-v" + nodeVersion + "-darwin-" + architecture + ".tar.gz",
      archiveRoot: "node-v" + nodeVersion + "-darwin-" + architecture,
      checksum: macChecksums[architecture],
      extractionName: "darwin-" + architecture,
    }));
  }
  const universalNode = path.join(binariesDirectory, "node-universal-apple-darwin");
  await mkdir(binariesDirectory, { recursive: true });
  run("/usr/bin/lipo", [
    "-create",
    path.join(runtimes.get("arm64"), "bin", "node"),
    path.join(runtimes.get("x64"), "bin", "node"),
    "-output",
    universalNode,
  ]);
  await chmod(universalNode, 0o755);
  const architectures = run("/usr/bin/lipo", ["-archs", universalNode]);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error("Universal Node runtime has unexpected architectures: " + architectures);
  }
  for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const sidecar = path.join(binariesDirectory, "node-" + triple);
    await rm(sidecar, { force: true });
    await link(universalNode, sidecar);
  }
  await copyFile(path.join(runtimes.get("arm64"), "LICENSE"), path.join(resourcesDirectory, "licenses", "Node-LICENSE"));
  return { path: universalNode, binary: "node" };
}

async function prepareNativeNode() {
  const runtime = await extractNode({
    archive: configuration.archive,
    archiveRoot: configuration.archiveRoot,
    checksum: configuration.checksum,
    extractionName: target,
  });
  const source = path.join(runtime, configuration.binaryPath);
  const sidecar = path.join(binariesDirectory, configuration.sidecar);
  await mkdir(binariesDirectory, { recursive: true });
  await rm(sidecar, { force: true });
  await copyFile(source, sidecar);
  if (configuration.platform === "linux") await chmod(sidecar, 0o755);
  await copyFile(path.join(runtime, "LICENSE"), path.join(resourcesDirectory, "licenses", "Node-LICENSE"));
  return { path: sidecar, binary: configuration.executable };
}

async function copyApplicationResources() {
  const app = path.join(resourcesDirectory, "app");
  await rm(resourcesDirectory, { recursive: true, force: true });
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await mkdir(app, { recursive: true });
  await Promise.all([
    cp(path.join(projectRoot, "server"), path.join(app, "server"), { recursive: true }),
    cp(path.join(projectRoot, "shared"), path.join(app, "shared"), { recursive: true }),
    cp(path.join(projectRoot, "dist", "web"), path.join(app, "dist", "web"), { recursive: true }),
    cp(path.join(projectRoot, "skills", "manage-taskboard"), path.join(app, "skills", "manage-taskboard"), { recursive: true }),
  ]);
  await mkdir(path.join(app, "scripts"), { recursive: true });
  for (const fileName of [
    "codex-cdp-pipe.mjs",
    "codex-injector.mjs",
    "codex-injector-runtime.mjs",
    "codex-rate-limits.mjs",
    "taskboard-supervisor.mjs",
  ]) {
    await copyFile(path.join(projectRoot, "scripts", fileName), path.join(app, "scripts", fileName));
  }
  await mkdir(path.join(app, "inject"), { recursive: true });
  await copyFile(path.join(projectRoot, "inject", "codex-taskboard.user.js"), path.join(app, "inject", "codex-taskboard.user.js"));
  await mkdir(path.join(app, "cli"), { recursive: true });
  await copyFile(path.join(projectRoot, "cli", "taskctl.mjs"), path.join(app, "cli", "taskctl.mjs"));
  await copyFile(path.join(tauriRoot, "licenses", "Lobe-Icons-LICENSE.txt"), path.join(resourcesDirectory, "licenses", "Lobe-Icons-LICENSE.txt"));
}

async function writeTaskctlWrapper(node) {
  const bin = path.join(resourcesDirectory, "bin");
  await mkdir(bin, { recursive: true });
  if (configuration.platform === "macos") {
    const lines = ["#!/bin/zsh", "set -u", "SCRIPT_DIR=\"$(cd \"$(dirname \"$0\")\" && pwd)\"", "CONTENTS_DIR=\"$(cd \"$SCRIPT_DIR/../..\" && pwd)\"", "export CODEX_TASKBOARD_DATA_DIR=\"$HOME/Library/Application Support/Codex Taskboard\"", "export CODEX_TASKBOARD_URL=\"http://127.0.0.1:47823\"", "exec \"$CONTENTS_DIR/MacOS/node\" \"$CONTENTS_DIR/Resources/app/cli/taskctl.mjs\" \"$@\"", ""];
    const taskctl = path.join(bin, "taskctl");
    await writeFile(taskctl, lines.join("\n"));
    await chmod(taskctl, 0o755);
    return;
  }
  const bundledNode = path.join(bin, node.binary);
  await copyFile(node.path, bundledNode);
  if (configuration.platform === "windows") {
    const lines = ["@echo off", "setlocal", "set \"SCRIPT_DIR=%~dp0\"", "set \"CODEX_TASKBOARD_DATA_DIR=%LOCALAPPDATA%\\\\Codex Taskboard\"", "set \"CODEX_TASKBOARD_URL=http://127.0.0.1:47823\"", "\"%SCRIPT_DIR%node.exe\" \"%SCRIPT_DIR%..\\\\app\\\\cli\\\\taskctl.mjs\" %*", ""];
    await writeFile(path.join(bin, "taskctl.cmd"), lines.join("\r\n"));
    return;
  }
  const lines = ["#!/bin/sh", "set -eu", "SCRIPT_DIR=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"", "export CODEX_TASKBOARD_DATA_DIR=\"$HOME/.local/share/Codex Taskboard\"", "export CODEX_TASKBOARD_URL=\"http://127.0.0.1:47823\"", "exec \"$SCRIPT_DIR/node\" \"$SCRIPT_DIR/../app/cli/taskctl.mjs\" \"$@\"", ""];
  const taskctl = path.join(bin, "taskctl");
  await writeFile(taskctl, lines.join("\n"));
  await chmod(taskctl, 0o755);
}

async function runtimeFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await runtimeFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

async function prepareDaemonRuntime(node) {
  const runtime = path.join(resourcesDirectory, "daemon-runtime");
  const app = path.join(runtime, "app");
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  await rm(runtime, { recursive: true, force: true });
  await mkdir(app, { recursive: true });
  await Promise.all([
    copyFile(node.path, path.join(runtime, node.binary)),
    copyFile(path.join(projectRoot, "scripts", "taskboard-daemon.mjs"), path.join(app, "taskboard-daemon.mjs")),
    cp(path.join(projectRoot, "server"), path.join(app, "server"), { recursive: true }),
    cp(path.join(projectRoot, "shared"), path.join(app, "shared"), { recursive: true }),
    cp(path.join(projectRoot, "dist", "web"), path.join(app, "dist", "web"), { recursive: true }),
  ]);
  if (configuration.platform !== "windows") await chmod(path.join(runtime, node.binary), 0o755);
  const files = {};
  for (const relative of await runtimeFiles(runtime)) {
    if (relative !== "runtime-manifest.json") files[relative] = await sha256(path.join(runtime, relative));
  }
  await writeFile(path.join(runtime, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, version: packageJson.version, files }, null, 2) + "\n");
}

requireNativeHost(configuration.platform);
await mkdir(runtimeCacheDirectory, { recursive: true });
await copyApplicationResources();
const node = configuration.platform === "macos" ? await prepareMacNode() : await prepareNativeNode();
await writeTaskctlWrapper(node);
await prepareDaemonRuntime(node);
await rm(extractionDirectory, { recursive: true, force: true });
console.log("Prepared Tauri resources for " + target + " with Node.js " + nodeVersion);
