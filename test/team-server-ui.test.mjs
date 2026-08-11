import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const component = await readFile(new URL("../web/src/components/TeamServerSettings.tsx", import.meta.url), "utf8");
const api = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("Team Server settings expose profiles, Keychain login, activation, and connection tests", () => {
  assert.match(component, /listTeamProfiles/);
  assert.match(component, /createTeamProfile/);
  assert.match(component, /activateTeamProfile/);
  assert.match(component, /loginTeamProfile/);
  assert.match(component, /testTeamProfile/);
  assert.match(component, /hasToken/);
  assert.doesNotMatch(component, /localStorage|sessionStorage/);
  assert.doesNotMatch(api, /token.*localStorage|localStorage.*token/i);
});
test("settings show operational sync state and complete controls", () => {
  for (const contract of [
    /pendingOperations/,
    /branchCount/,
    /lastSuccessfulSyncAt/,
    /pauseTeamSync/,
    /resumeTeamSync/,
    /synchronizeTeamNow/,
    /updateMirror/,
  ]) assert.match(component, contract);
  assert.match(component, /type="password"/);
  assert.match(component, /role="dialog"/);
});

test("App opens Team Server settings from an icon control and styles a responsive operational dialog", () => {
  assert.match(app, /TeamServerSettings/);
  assert.match(app, /teamSettingsOpen/);
  assert.match(app, /aria-label=\{text\("Team Server 设置", "Team Server settings"\)\}/);
  assert.match(styles, /\.team-settings-dialog/);
  assert.match(styles, /@media \(max-width:\s*719px\)[\s\S]*?\.team-settings-dialog/);
});
