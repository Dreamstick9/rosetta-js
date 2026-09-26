import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quote, sh } from "./shell.js";

const CACHE_DIR = path.join(os.homedir(), ".cache", "rosetta-js", "evals", "repos");
const SETUP_TIMEOUT_MS = 900_000;
const EXCLUDES = [".venv/", "node_modules/", "*.egg-info/", "__pycache__/", ".pytest_cache/"];
const GIT_USER = "-c user.name=eval -c user.email=eval@example.invalid";

export async function ensureClones(tasks) {
  for (const task of tasks) await ensureClone(task);
}

async function ensureClone(task) {
  const clone = clonePath(task.repo);
  if (!fs.existsSync(clone)) await must(`git clone -q --filter=blob:none --no-checkout ${quote(task.repo)} ${quote(clone)}`);
  const present = await sh(`git -C ${quote(clone)} cat-file -e ${task.commit}^{commit}`);
  if (present.code !== 0) await must(`git -C ${quote(clone)} fetch -q origin ${task.commit}`);
}

function clonePath(repo) {
  const name = repo.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "").replaceAll("/", "_");
  return path.join(CACHE_DIR, name);
}

export async function prepareWorkspace(task, repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  await must(`git -C ${quote(clonePath(task.repo))} archive ${task.commit} | tar -x -C ${quote(repoDir)}`);
  for (const command of task.setup) await must(command, { cwd: repoDir, env: taskEnv(task, repoDir), timeoutMs: SETUP_TIMEOUT_MS });
  await must(baselineCommand(), { cwd: repoDir });
}

function baselineCommand() {
  const excludes = EXCLUDES.map(quote).join(" ");
  return `git init -q && printf '%s\\n' ${excludes} >> .git/info/exclude && git add -A && git ${GIT_USER} commit -qm base --no-verify`;
}

export function taskEnv(task, repoDir, extra = {}) {
  return { ...process.env, EVAL_TASK_DIR: task.dir, EVAL_REPO: repoDir, ...extra };
}

export async function must(command, options = {}) {
  const result = await sh(command, options);
  if (result.code !== 0) throw new Error(`Command failed: ${command}\n${result.output.slice(-2000)}`);
  return result;
}
