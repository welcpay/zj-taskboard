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

test("Codex 151 loads Taskboard through a protected blob document", () => {
  assert.match(injection, /function taskboardBlobPrelude/);
  assert.match(injection, /URL\.createObjectURL\(new Blob/);
  assert.match(injection, /__CODEX_TASKBOARD_FRAME_CAPABILITY__/);
  assert.match(injection, /__codex_taskboard_embed_token/);
  assert.match(injection, /Object\.defineProperty\(window, "localStorage"/);
  assert.match(injection, /__codexTaskboardEmbedToken__/);
  assert.match(injection, /frameIsBlob \? Promise\.resolve\(\) : requestHostLoadFrame/);
  assert.match(injection, /if \(!frameIsBlob\) await requestHostLoadFrame/);
  assert.match(injection, /siblings\.length >= 2/);
  assert.match(injector, /window\.__codexTaskboardHtml__/);
  assert.match(injector, /registerTaskboardEmbedToken/);
  assert.match(server, /TRUSTED_EMBED_ORIGINS = new Set\(\["app:\/\/-", "null"\]\)/);
  assert.match(server, /EMBED_TOKEN_HEADER/);
});

test("Codex 151 attaches the sandboxed frame before starting its blob navigation", () => {
  const loadFrameStart = injection.indexOf("function loadTaskboardFrame(");
  const loadFrameEnd = injection.indexOf("\n  function reloadFrame()", loadFrameStart);
  const loadFrameSource = injection.slice(loadFrameStart, loadFrameEnd);
  const listenAt = loadFrameSource.indexOf('nextFrame.addEventListener("load"');
  const appendAt = loadFrameSource.indexOf("page.appendChild(nextFrame)");
  const blobNavigateAt = loadFrameSource.indexOf("if (blobUrl) nextFrame.src = blobUrl");

  assert.ok(listenAt >= 0, "frame load listener is registered");
  assert.ok(appendAt > listenAt, "frame is attached after registering its load listener");
  assert.ok(blobNavigateAt > appendAt, "blob navigation starts only after the frame is attached");
});
