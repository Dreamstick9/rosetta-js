import fs from "node:fs";
import path from "node:path";
import { lastLines, quote, sh } from "./shell.js";
import { must, taskEnv } from "./workspace.js";

const GRADE_TIMEOUT_MS = 600_000;

export async function grade(task, repoDir, agentLog) {
  await restorePaths(task.restore ?? [], repoDir);
  await addHiddenTests(task, repoDir);
  const env = taskEnv(task, repoDir, { EVAL_AGENT_OUTPUT: agentLog });
  const result = await sh(task.grade, { cwd: repoDir, env, timeoutMs: GRADE_TIMEOUT_MS });
  return { passed: result.code === 0, output: lastLines(result.output, 40) };
}

async function restorePaths(paths, repoDir) {
  for (const target of paths) await sh(`git checkout HEAD -- ${quote(target)} && git clean -fdq -- ${quote(target)}`, { cwd: repoDir });
}

async function addHiddenTests(task, repoDir) {
  if (task.hidden?.files) fs.cpSync(path.join(task.dir, task.hidden.files), repoDir, { recursive: true });
  if (task.hidden?.patch) await applyPatch(path.join(task.dir, task.hidden.patch), repoDir, true);
}

export async function applyPatch(patchFile, repoDir, resetTouched) {
  if (resetTouched) for (const file of patchedFiles(patchFile)) await resetFile(file, repoDir);
  await must(`git apply --whitespace=nowarn ${quote(patchFile)}`, { cwd: repoDir });
}

function patchedFiles(patchFile) {
  const text = fs.readFileSync(patchFile, "utf8");
  return [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].flatMap((match) => [match[1], match[2]]);
}

async function resetFile(file, repoDir) {
  const tracked = await sh(`git cat-file -e HEAD:${quote(file)}`, { cwd: repoDir });
  if (tracked.code === 0) await must(`git checkout HEAD -- ${quote(file)}`, { cwd: repoDir });
  else fs.rmSync(path.join(repoDir, file), { force: true });
}
