import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactNames,
  dmgFileName,
  localSignTargets,
  nextPatchVersion,
  resolveReleaseVersion,
} from "../scripts/release-app.mjs";
import { renderReleaseNotes } from "../scripts/release-notes.mjs";

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
