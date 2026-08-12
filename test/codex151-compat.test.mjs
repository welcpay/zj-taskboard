import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const injection = await readFile(
  new URL("../inject/codex-taskboard.user.js", import.meta.url),
  "utf8",
);
const injector = await readFile(
  new URL("../scripts/codex-injector.mjs", import.meta.url),
  "utf8",
);
const server = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");

test("Codex 151 loads Taskboard through an authenticated sandboxed document", () => {
  assert.match(injection, /nextFrame\.src = "about:blank"/);
  assert.match(injection, /await requestHostLoadFrame\(frameRequest\)/);
  assert.match(injection, /siblings\.length >= 2/);
  assert.match(injector, /Page\.setDocumentContent/);
  assert.match(injector, /verifiedTaskboardDocument/);
  assert.match(injector, /__CODEX_TASKBOARD_FRAME_CAPABILITY__/);
  assert.match(server, /TRUSTED_EMBED_ORIGINS = new Set\(\["app:\/\/-", "null"\]\)/);
  assert.doesNotMatch(injection, /URL\.createObjectURL\(new Blob/);
  assert.doesNotMatch(injector, /__codexTaskboardHtml__/);
});

test("Codex 151 attaches the sandboxed frame before authenticated CDP document loading", () => {
  const loadFrameStart = injection.indexOf("function loadTaskboardFrame(");
  const loadFrameEnd = injection.indexOf("\n  function reloadFrame()", loadFrameStart);
  const loadFrameSource = injection.slice(loadFrameStart, loadFrameEnd);
  const listenAt = loadFrameSource.indexOf('nextFrame.addEventListener("load"');
  const appendAt = loadFrameSource.indexOf("page.appendChild(nextFrame)");
  const aboutBlankAt = loadFrameSource.indexOf('nextFrame.src = "about:blank"');

  assert.ok(listenAt >= 0, "frame load listener is registered");
  assert.ok(appendAt > listenAt, "frame is attached after registering its load listener");
  assert.ok(aboutBlankAt >= 0, "sandboxed frame starts at about:blank");
  assert.ok(aboutBlankAt < appendAt, "about:blank is set before the frame is attached");
});
