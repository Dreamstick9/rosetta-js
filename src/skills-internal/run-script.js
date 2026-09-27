import { spawnSync } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { buildChildEnvironment } from "../environment.js";
import { SKILLS_DIRECTORY } from "./catalog.js";

const SCRIPT_TIMEOUT_MS = 10_000;

let pythonAvailable = null;

export function hasPython() {
  pythonAvailable ??= spawnSync("python3", ["--version"], { timeout: SCRIPT_TIMEOUT_MS }).status === 0;
  return pythonAvailable;
}

export function skillScriptPath(skillName, script) {
  return path.join(SKILLS_DIRECTORY, skillName, "scripts", script);
}

export function runSkillScript(skillName, script, args) {
  if (!hasPython()) return null;
  const result = spawnSync("python3", [skillScriptPath(skillName, script), ...args], {
    cwd: PROJECT_ROOT,
    env: buildChildEnvironment(),
    encoding: "utf8",
    timeout: SCRIPT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const output = result.stdout.trim();
  return output || null;
}

export function firstLines(text, count) {
  return text.split("\n").slice(0, count).join("\n");
}
