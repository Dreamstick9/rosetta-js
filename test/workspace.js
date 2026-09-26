import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, setProjectRoot } from "../src/config.js";
import { changedFiles, createWorkspace, mergeWorkspace, removeWorkspace } from "../src/agents/workspace.js";
import { WORKSPACES_ROOT } from "../src/paths.js";
import { getRole } from "../src/roles.js";
import { runToolCalls } from "../src/tools/index.js";
import { createShellSession, stopShellSession } from "../src/tools/shell.js";

const RUN_ID = `test-${process.pid}`;
const MAIN_FILES = {
  "README.md": "# demo\n",
  "src/app.js": "export const answer = 41;\n",
  "src/util.js": "export const name = 'util';\n",
  ".git/HEAD": "ref: refs/heads/main\n",
  ".rosetta/state.json": "{}\n",
  "node_modules/pkg/index.js": "module.exports = 1;\n",
  "packages/web/node_modules/dep/index.js": "module.exports = 2;\n",
};

const checks = [];
const cleanups = [];

function check(label, run) {
  checks.push({ label, run });
}

function createMainRoot() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rjs-workspace-test-"));
  for (const [name, content] of Object.entries(MAIN_FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function newWorkspace(root, agentId) {
  const workspace = createWorkspace({ root, runId: RUN_ID, agentId });
  cleanups.push(() => removeWorkspace(workspace));
  return workspace;
}

function readText(folder, file) {
  return fs.readFileSync(path.join(folder, file), "utf8");
}

async function runOne(name, args, context) {
  const [result] = await runToolCalls([{ id: "1", name, args }], { signal: new AbortController().signal, ...context });
  return result;
}

check("the copy leaves out .git and .rosetta and links dependency folders", () => {
  const root = createMainRoot();
  const workspace = newWorkspace(root, "copy");
  assert.equal(readText(workspace.dir, "src/app.js"), MAIN_FILES["src/app.js"]);
  assert.ok(!fs.existsSync(path.join(workspace.dir, ".git")));
  assert.ok(!fs.existsSync(path.join(workspace.dir, ".rosetta")));
  assert.ok(fs.lstatSync(path.join(workspace.dir, "node_modules")).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(workspace.dir, "packages/web/node_modules")), path.join(root, "packages/web/node_modules"));
  assert.deepEqual([...workspace.base.keys()].sort(), ["README.md", "src/app.js", "src/util.js"]);
  removeWorkspace(workspace);
  assert.ok(fs.existsSync(path.join(root, "node_modules/pkg/index.js")));
});

check("changed files and a clean merge with a delete", () => {
  const root = createMainRoot();
  const workspace = newWorkspace(root, "clean");
  fs.writeFileSync(path.join(workspace.dir, "src/app.js"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(workspace.dir, "src/new.js"), "export const fresh = true;\n");
  fs.rmSync(path.join(workspace.dir, "README.md"));
  const changes = changedFiles(workspace).map(({ file, change }) => `${change} ${file}`);
  assert.deepEqual(changes, ["deleted README.md", "modified src/app.js", "added src/new.js"]);
  const result = mergeWorkspace(workspace);
  assert.deepEqual(result, { applied: ["README.md", "src/app.js", "src/new.js"], conflicts: [] });
  assert.equal(readText(root, "src/app.js"), "export const answer = 42;\n");
  assert.equal(readText(root, "src/new.js"), "export const fresh = true;\n");
  assert.ok(!fs.existsSync(path.join(root, "README.md")));
});

check("a file changed in main and in the worker is a conflict that keeps main", () => {
  const root = createMainRoot();
  const workspace = newWorkspace(root, "conflict");
  fs.writeFileSync(path.join(root, "src/app.js"), "export const answer = 40;\n");
  fs.writeFileSync(path.join(workspace.dir, "src/app.js"), "export const answer = 43;\n");
  fs.writeFileSync(path.join(workspace.dir, "src/util.js"), "export const name = 'tool';\n");
  const result = mergeWorkspace(workspace);
  assert.deepEqual(result.applied, ["src/util.js"]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].file, "src/app.js");
  assert.match(result.conflicts[0].diff, /-export const answer = 40;/);
  assert.match(result.conflicts[0].diff, /\+export const answer = 43;/);
  assert.match(result.conflicts[0].diff, /main\/src\/app\.js/);
  assert.equal(readText(root, "src/app.js"), "export const answer = 40;\n");
  assert.equal(readText(root, "src/util.js"), "export const name = 'tool';\n");
});

check("two tool contexts write into their own roots and cannot write into each other", async () => {
  const root = createMainRoot();
  setProjectRoot(root);
  const workspace = newWorkspace(root, "tools");
  const main = { root };
  const worker = { root: workspace.dir, role: "worker" };
  assert.equal((await runOne("write_file", { path: "note.txt", content: "main" }, main)).status, "ok");
  assert.equal((await runOne("write_file", { path: "note.txt", content: "worker" }, worker)).status, "ok");
  assert.equal(readText(root, "note.txt"), "main");
  assert.equal(readText(workspace.dir, "note.txt"), "worker");
  assert.equal((await runOne("write_file", { path: path.join(root, "x.txt"), content: "" }, worker)).status, "blocked");
  assert.equal((await runOne("write_file", { path: path.join(workspace.dir, "x.txt"), content: "" }, main)).status, "blocked");
  assert.equal((await runOne("bash", { command: `echo hi > ${root}/x.txt` }, { ...worker, shell: createShellSession(workspace.dir) })).status, "blocked");
  const listing = await runOne("list_files", { path: "src" }, worker);
  assert.deepEqual(listing.output.split("\n"), ["src/app.js", "src/util.js"]);
});

check("an explorer is refused tools outside its role", async () => {
  const root = createMainRoot();
  const result = await runOne("write_file", { path: "a.txt", content: "" }, { root, role: "explorer" });
  assert.equal(result.status, "error");
  assert.equal(result.output, "Error: tool write_file is not available to the explorer role");
  assert.equal((await runOne("read_file", { path: "README.md" }, { root, role: "explorer" })).status, "ok");
  assert.equal(getRole("explorer").maxTurns, CONFIG.agents.explorerMaxTurns);
});

check("two shell sessions keep their own working folders", async () => {
  const first = createMainRoot();
  const second = createMainRoot();
  const firstShell = createShellSession(first);
  const secondShell = createShellSession(second);
  try {
    await runOne("bash", { command: "cd src" }, { root: first, shell: firstShell });
    const firstPwd = await runOne("bash", { command: "pwd -P" }, { root: first, shell: firstShell });
    const secondPwd = await runOne("bash", { command: "pwd -P" }, { root: second, shell: secondShell });
    assert.equal(firstPwd.output.split("\n")[0], path.join(first, "src"));
    assert.equal(secondPwd.output, `${second}\n[exit code 0]`);
  } finally {
    stopShellSession(firstShell);
    stopShellSession(secondShell);
  }
});

async function main() {
  const failures = [];
  for (const { label, run } of checks) {
    try {
      await run();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  for (const cleanup of cleanups) cleanup();
  fs.rmSync(path.join(WORKSPACES_ROOT, RUN_ID), { recursive: true, force: true });
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL workspace: ${failure}`);
    process.exit(1);
  }
  console.log(`PASS workspace: ${checks.length} checks.`);
}

main();
