import fs from "node:fs";
import path from "node:path";
import { run } from "./shell.js";
import { applyConfigSettings } from "./settings.js";

const SKIPPED = new Set([".git", "runs", "evals", ".tools", "node_modules", ".env"]);
const CLEARED_ENV = ["REPO_PATH", "ISSUE"];

export function copyHarness(sourceDir, targetDir, configOverrides) {
  fs.cpSync(sourceDir, targetDir, { recursive: true, filter: (file) => !SKIPPED.has(path.relative(sourceDir, file)) });
  const configFile = path.join(targetDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  fs.writeFileSync(configFile, `${JSON.stringify(applyConfigSettings(config, configOverrides), null, 2)}\n`);
}

export async function runHarness({ harnessDir, sourceDir, repoDir, taskText, env, timeoutMs }) {
  const startedAt = Date.now();
  const result = await run(process.execPath, ["src/cli.js"], {
    cwd: harnessDir,
    env: harnessEnv(sourceDir, repoDir, env),
    input: taskText,
    timeoutMs,
  });
  return { ...result, seconds: (Date.now() - startedAt) / 1000, traceFile: findTrace(harnessDir) };
}

function harnessEnv(sourceDir, repoDir, extra) {
  const env = { ...process.env, ...extra };
  for (const name of CLEARED_ENV) delete env[name];
  env.REPO = repoDir;
  const venv = path.join(repoDir, ".venv");
  const venvDirs = fs.existsSync(venv) ? [path.join(venv, "bin")] : [];
  if (venvDirs.length > 0) env.VIRTUAL_ENV = venv;
  const nodeDirs = [path.join(sourceDir, ".tools", "node", "bin"), path.dirname(process.execPath)];
  env.PATH = [...venvDirs, ...nodeDirs, env.PATH].join(path.delimiter);
  return env;
}

function findTrace(harnessDir) {
  const runsDir = path.join(harnessDir, "runs");
  if (!fs.existsSync(runsDir)) return null;
  const traces = fs.readdirSync(runsDir).sort().map((name) => path.join(runsDir, name, "trace.jsonl"));
  return traces.filter((file) => fs.existsSync(file)).at(-1) ?? null;
}
