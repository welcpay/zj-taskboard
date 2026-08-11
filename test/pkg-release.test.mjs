import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { postinstallScript } from "../scripts/create-macos-pkg.mjs";

const workflow = await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8");
const verifier = await readFile(new URL("../scripts/verify-macos-release.mjs", import.meta.url), "utf8");
const launcher = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

test("the macOS release publishes a signed notarized PKG beside every other artifact", () => {
  assert.match(workflow, /create-macos-pkg\.mjs/);
  assert.match(workflow, /Codex\.Taskboard_\$\{PACKAGE_VERSION\}_universal\.pkg/);
  assert.match(workflow, /productsign/);
  assert.match(workflow, /notarytool submit[\s\S]*?\.pkg/);
  assert.match(workflow, /stapler staple[\s\S]*?\.pkg/);
  assert.match(workflow, /release-assets\.sha256[\s\S]*?\.pkg/);
  assert.match(workflow, /gh release create[\s\S]*?\.pkg/);
});

test("the PKG stops the previous daemon and lets the installed App reconcile the new runtime", async () => {
  const source = await readFile(new URL("../scripts/create-macos-pkg.mjs", import.meta.url), "utf8");
  assert.match(source, /com\.chuspeeism\.codex-taskboard\.daemon/);
  assert.match(source, /launchctl[\s\S]*?bootout/);
  assert.match(source, /open[\s\S]*?Codex Taskboard\.app/);
  assert.match(source, /pkgbuild/);
  assert.match(source, /productbuild/);
  const postinstall = postinstallScript("0.3.0");
  assert.match(postinstall, /daemonVersion/);
  assert.match(postinstall, /0\.3\.0/);
  assert.match(postinstall, /127\.0\.0\.1:47823\/health/);
  assert.match(postinstall, /exit 1/);
});

test("release verification checks the PKG payload, identity, notarization, and version parity", () => {
  assert.match(verifier, /pkgPath/);
  assert.match(verifier, /pkgutil[\s\S]*?--check-signature/);
  assert.match(verifier, /pkgutil[\s\S]*?--expand-full/);
  assert.match(verifier, /stapler[\s\S]*?pkgPath/);
  assert.match(verifier, /runtime-manifest\.json/);
  assert.match(verifier, /release-assets\.sha256/);
  assert.match(verifier, /pkgSignature[\s\S]*?appleTeamId/);
});

test("the App checks the authenticated local Team Server mirror before GitHub", () => {
  assert.match(launcher, /127\.0\.0\.1:47823\/api\/team\/updates\/latest\.json/);
  assert.match(launcher, /updater_builder\(\)[\s\S]*?endpoints/);
  assert.match(launcher, /github\.com\/welcpay\/zj-taskboard/);
  assert.equal(tauriConfig.plugins.updater.dangerousInsecureTransportProtocol, true);
});
