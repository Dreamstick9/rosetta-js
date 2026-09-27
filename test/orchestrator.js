import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CONFIG, setProjectRoot } from "../src/config.js";
import { buildBriefing } from "../src/agents/briefing.js";
import { applyFanOutRule, linkDependencies } from "../src/agents/graph.js";
import { Orchestrator } from "../src/agents/orchestrator.js";
import { WORKSPACES_ROOT } from "../src/paths.js";
import { checkToolCall } from "../src/policy.js";
import { createTurnStats } from "../src/turns.js";

const SETTINGS = { ...CONFIG.agents, maxParallelAgents: 3, fanOutMinItems: 2, fanOutMinFiles: 4 };
const PACKAGE_JSON = JSON.stringify({ name: "fixture", scripts: { test: "test -f a.txt && test -f b.txt" } });
const checks = [];
const roots = [];

function check(label, run) {
  checks.push({ label, run });
}

function createMainRoot() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rjs-orchestrator-test-"));
  fs.writeFileSync(path.join(root, "package.json"), PACKAGE_JSON);
  fs.writeFileSync(path.join(root, "shared.txt"), "base\n");
  roots.push(root);
  setProjectRoot(root);
  return root;
}

function request(role, prompt, extra = {}) {
  return { role, prompt, files: [], dependsOn: [], id: null, ...extra };
}

function createHarness(actions) {
  const log = { starts: [], running: 0, maxRunning: 0, waves: [], briefings: new Map(), mainAtStart: new Map() };
  const trace = { totals: { cost: 0 }, recordWave: (entry) => log.waves.push(entry) };
  const loop = { plan: { items: [], hasOpenChecks: () => false }, takeCheckpoint: () => null };
  const runAgent = async ({ item, root }) => {
    log.starts.push(item.prompt);
    log.running++;
    log.maxRunning = Math.max(log.maxRunning, log.running);
    log.briefings.set(item.prompt, buildBriefing({ item, root, planItems: [] }));
    log.mainAtStart.set(item.prompt, fs.readdirSync(process.cwd()).sort());
    await sleep(20);
    actions[item.prompt]?.(root);
    log.running--;
    return { outcome: "done", summary: `finished ${item.prompt}`, stats: createTurnStats() };
  };
  const orchestrator = new Orchestrator({ trace, loop, runAgent, settings: SETTINGS });
  return { orchestrator, log };
}

function writeIn(file, text) {
  return (root) => fs.writeFileSync(path.join(root, file), text);
}

check("depends_on and overlapping worker files become predecessors", () => {
  const items = [
    { ...request("worker", "A", { id: "a", files: ["x.js"] }), result: null },
    { ...request("worker", "B", { dependsOn: ["a"], files: ["y.js"] }), result: null },
    { ...request("worker", "C", { files: ["x.js"] }), result: null },
    { ...request("explorer", "D", { files: ["x.js"] }), result: null },
    { ...request("worker", "E", { dependsOn: ["missing"] }), result: null },
  ];
  linkDependencies(items, new Map());
  assert.deepEqual(items.map((item) => item.predecessors.map((predecessor) => predecessor.prompt).join(",")), ["", "A", "A", "", ""]);
  assert.match(items[4].result, /no task in this reply or earlier has that id/);
});

check("the fan-out rule refuses a lone small worker but keeps explorers", () => {
  const items = [{ ...request("worker", "fix", { files: ["a.js"] }), result: null }, { ...request("explorer", "look"), result: null }];
  linkDependencies(items, new Map());
  applyFanOutRule(items, SETTINGS);
  assert.match(items[0].result, /^Refused: .*Do this change yourself\.$/);
  assert.equal(items[1].result, null);
});

check("five explorers run in waves of at most three", async () => {
  createMainRoot();
  const { orchestrator, log } = createHarness({});
  const names = ["e1", "e2", "e3", "e4", "e5"];
  const results = await orchestrator.runTasks(names.map((name) => request("explorer", name)), new AbortController().signal);
  assert.equal(log.maxRunning, 3);
  assert.deepEqual(log.waves.map((wave) => wave.agents.length), [3, 2]);
  assert.match(results[4], /^\[explorer-5 explorer · done/);
});

check("two workers merge cleanly and the done-check passes", async () => {
  const root = createMainRoot();
  const { orchestrator, log } = createHarness({ one: writeIn("a.txt", "a\n"), two: writeIn("b.txt", "b\n") });
  const results = await orchestrator.runTasks([request("worker", "one", { files: ["a.txt"] }), request("worker", "two", { files: ["b.txt"] })], new AbortController().signal);
  assert.equal(log.maxRunning, 2);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "a\n");
  assert.match(results[0], /Merged into main: a\.txt/);
  assert.match(results[1], /Done-check after merging: `npm test --silent` passed\./);
  assert.equal(log.waves[0].check, true);
});

check("a dependent worker waits for the merge and gets its predecessor's result", async () => {
  createMainRoot();
  const { orchestrator, log } = createHarness({ lib: writeIn("lib.txt", "lib\n"), app: writeIn("app.txt", "app\n") });
  const requests = [request("worker", "app", { dependsOn: ["L"], files: ["app.txt", "app2.txt"] }), request("worker", "lib", { id: "L", files: ["lib.txt", "lib2.txt"] })];
  await orchestrator.runTasks(requests, new AbortController().signal);
  assert.deepEqual(log.starts, ["lib", "app"]);
  assert.ok(log.mainAtStart.get("app").includes("lib.txt"));
  assert.match(log.briefings.get("app"), /## worker-1 \(id L\)\n\[worker-1 worker · done[^\n]*\nfinished lib\nChanged files: lib\.txt \(added\)\nMerged into main: lib\.txt/);
});

check("a file changed by an earlier merge is a conflict that keeps main", async () => {
  const root = createMainRoot();
  const { orchestrator } = createHarness({ first: writeIn("shared.txt", "first\n"), second: writeIn("shared.txt", "second\n") });
  const results = await orchestrator.runTasks([request("worker", "first", { files: ["a.txt", "b.txt"] }), request("worker", "second", { files: ["c.txt", "d.txt"] })], new AbortController().signal);
  assert.equal(fs.readFileSync(path.join(root, "shared.txt"), "utf8"), "first\n");
  assert.match(results[0], /Merged into main: shared\.txt/);
  assert.match(results[1], /Conflict in shared\.txt: main changed it[\s\S]*-first\n\+second/);
});

check("a read-only agent's bash cannot write or delete", () => {
  const root = createMainRoot();
  const blocked = ["echo x > notes.txt", "rm shared.txt", "touch /tmp/rjs-x", "sed -i s/a/b/ shared.txt", "git commit -m x", "npm install left-pad"];
  const allowed = ["cat shared.txt 2>/dev/null", "ls -la | head", "git log --oneline -3", "grep -rn base . > /dev/null"];
  for (const command of blocked) assert.ok(checkToolCall("bash", { command }, root, root, true), `not blocked: ${command}`);
  for (const command of allowed) assert.equal(checkToolCall("bash", { command }, root, root, true), null, `blocked: ${command}`);
  assert.equal(checkToolCall("bash", { command: "echo x > notes.txt" }, root, root, false), null);
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
  process.chdir("/tmp");
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  for (const name of fs.readdirSync(WORKSPACES_ROOT)) {
    if (name.endsWith(`-${process.pid}`)) fs.rmSync(path.join(WORKSPACES_ROOT, name), { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL orchestrator: ${failure}`);
    process.exit(1);
  }
  console.log(`PASS orchestrator: ${checks.length} checks.`);
}

main();
