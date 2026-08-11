import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const component = await readFile(new URL("../web/src/components/TaskBranchResolver.tsx", import.meta.url), "utf8");
const api = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("branch resolver compares base, main, and branch snapshots", () => {
  assert.match(component, /baseSnapshot/);
  assert.match(component, /mainSnapshot/);
  assert.match(component, /branchSnapshot/);
  assert.match(component, /branch-field-grid/);
  assert.match(component, /textarea/);
});

test("branch resolution supports keep-main, promotion, and editable three-way merge", () => {
  assert.match(component, /keepMainTaskBranch/);
  assert.match(component, /promoteTaskBranch/);
  assert.match(component, /mergeTaskBranch/);
  assert.match(api, /\/keep-main/);
  assert.match(api, /\/promote/);
  assert.match(api, /\/merge/);
});

test("merge actions are hidden without server permission and remain usable on narrow screens", () => {
  assert.match(component, /canResolve/);
  assert.match(component, /canResolve \?/);
  assert.match(styles, /\.task-branch-resolver/);
  assert.match(styles, /@media \(max-width:\s*719px\)[\s\S]*?\.branch-field-grid/);
});
