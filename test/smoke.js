import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const RUN_TIMEOUT_MS = 300_000;
const TASK = "The test in test.js fails: add(2, 3) should be 5. Fix the bug in math.js.";
const FIXTURE_FILES = {
  "package.json": JSON.stringify({ name: "smoke", type: "module", scripts: { test: "node test.js" } }, null, 2),
  "math.js": "export function add(a, b) {\n  return a - b;\n}\n",
  "test.js": 'import { add } from "./math.js";\nif (add(2, 3) !== 5) {\n  console.error("add(2, 3) should be 5");\n  process.exit(1);\n}\nconsole.log("ok");\n',
};

function main() {
  if (!process.env.AI_API_KEY) {
    console.log("SKIP live smoke run: AI_API_KEY is not set (export it to run the real agent test).");
    return;
  }
  const folder = createFixture();
  console.log(`Smoke run in ${folder}`);
  const run = spawnSync(process.execPath, [CLI_PATH, "-p", TASK], {
    env: { ...process.env, REPO: folder },
    stdio: "inherit",
    timeout: RUN_TIMEOUT_MS,
  });
  if (run.status !== 0) fail(`the agent exited with status ${run.status}`, folder);
  const check = spawnSync(process.execPath, ["test.js"], { cwd: folder, encoding: "utf8" });
  if (check.status !== 0) fail(`the fixture test still fails: ${check.stderr.trim()}`, folder);
  fs.rmSync(folder, { recursive: true, force: true });
  console.log("PASS smoke run: the agent fixed the fixture bug.");
}

function createFixture() {
  const folder = fs.mkdtempSync("/tmp/rjs-smoke-");
  for (const [name, content] of Object.entries(FIXTURE_FILES)) {
    fs.writeFileSync(path.join(folder, name), content);
  }
  return folder;
}

function fail(reason, folder) {
  console.error(`FAIL smoke run: ${reason}. The fixture is kept in ${folder}.`);
  process.exit(1);
}

main();
