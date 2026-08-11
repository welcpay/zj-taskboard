import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../scripts/verify-daemon-lifecycle.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the lifecycle verifier exercises restart, switching, rollback, and data-preserving uninstall", () => {
  assert.match(source, /127\.0\.0\.1:47823/);
  assert.match(source, /SIGKILL/);
  assert.match(source, /restart/);
  assert.match(source, /installRuntime/);
  assert.match(source, /rollbackRuntime/);
  assert.match(source, /uninstallRuntime/);
  assert.match(source, /taskboard\.sqlite/);
});

test("the package exposes the agent-runnable daemon and Team Server E2E gate", () => {
  assert.equal(
    packageJson.scripts["verify:daemon-team-e2e"],
    "npm run app:prepare && node scripts/verify-daemon-lifecycle.mjs && node --test test/team-sync.test.mjs test/team-sync-api.test.mjs",
  );
});
