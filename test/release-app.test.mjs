import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  artifactNames,
  dmgFileName,
  localSignTargets,
  nextPatchVersion,
  resolveReleaseVersion,
} from "../scripts/release-app.mjs";
import { renderReleaseNotes } from "../scripts/release-notes.mjs";

const releaseVersion = "0.2.6";

test("release 0.2.6 keeps every application version source in sync", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const cargoToml = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
  const cargoLock = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8");
  const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const injector = readFileSync(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");

  assert.equal(packageJson.version, releaseVersion);
  assert.equal(packageLock.version, releaseVersion);
  assert.equal(packageLock.packages[""].version, releaseVersion);
  assert.match(cargoToml, /^version = "0\.2\.6"$/m);
  assert.match(cargoLock, /\[\[package\]\]\nname = "codex-taskboard-launcher"\nversion = "0\.2\.6"/);
  assert.equal(tauriConfig.version, releaseVersion);
  assert.match(injector, /const VERSION = "0\.6\.14"/);
});

test("release versions increment and explicit versions are validated", () => {
  assert.equal(nextPatchVersion("0.2.2"), "0.2.3");
  assert.equal(resolveReleaseVersion({ current: "0.2.0", requested: "0.2.2" }), "0.2.2");
  assert.equal(resolveReleaseVersion({ current: "0.2.2", requested: "0.2.2" }), "0.2.2");
  assert.throws(() => resolveReleaseVersion({ current: "0.2.2", requested: "0.2.1" }));
  assert.equal(dmgFileName("0.2.2"), "Codex Taskboard 0.2.2.dmg");
});

test("release notes contain the version, changes, and data promise", () => {
  const notes = renderReleaseNotes({ version: "0.2.2", date: "2026-08-10", changes: ["修复自动认领"] });
  assert.match(notes, /# Codex Taskboard 0\.2\.2/);
  assert.match(notes, /- 修复自动认领/);
  assert.match(notes, /历史项目、议题、评论和自动化策略/);
});

test("local release signing preserves the bundled Node Foundation signature", () => {
  assert.deepEqual(localSignTargets("/tmp/Codex Taskboard.app"), [
    "/tmp/Codex Taskboard.app/Contents/MacOS/codex-taskboard-launcher",
    "/tmp/Codex Taskboard.app",
  ]);
});

test("every macOS release artifact derives from one version", () => {
  assert.deepEqual(artifactNames("0.3.0"), {
    dmg: "Codex.Taskboard_0.3.0_macOS-universal.dmg",
    pkg: "Codex.Taskboard_0.3.0_universal.pkg",
    updater: "Codex.Taskboard_0.3.0_universal.app.tar.gz",
    updaterSignature: "Codex.Taskboard_0.3.0_universal.app.tar.gz.sig",
    latest: "latest.json",
    checksums: "release-assets.sha256",
    metadata: "release-metadata.json",
  });
});
