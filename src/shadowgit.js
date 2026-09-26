import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXCLUDED_PATHS = [".git/", ".rosetta/", "node_modules/", ".venv/", "__pycache__/"];
const GIT_SETTINGS = ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "commit.gpgSign=false", "-c", "core.autocrlf=false", "-c", "core.quotePath=false", "-c", "advice.addEmbeddedRepo=false"];
const GIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const IDENTITY = {
  GIT_AUTHOR_NAME: "rosetta",
  GIT_AUTHOR_EMAIL: "rosetta@localhost",
  GIT_COMMITTER_NAME: "rosetta",
  GIT_COMMITTER_EMAIL: "rosetta@localhost",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
};

export function createShadow(shadow) {
  if (!fs.existsSync(path.join(shadow, "HEAD"))) runGit(["init", "--bare", "-q", shadow], path.dirname(shadow), false);
  fs.mkdirSync(path.join(shadow, "info"), { recursive: true });
  fs.writeFileSync(path.join(shadow, "info", "exclude"), `${EXCLUDED_PATHS.join("\n")}\n`);
  return shadow;
}

export function runGit(args, cwd, allowFailure) {
  const result = spawnSync("git", [...GIT_SETTINGS, ...args], {
    cwd,
    env: buildGitEnvironment(),
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.status === 0) return result.stdout.trimEnd();
  if (allowFailure) return "";
  const detail = (result.stderr || result.error?.message || "").trim().split("\n")[0];
  throw new Error(`shadow git failed: ${detail}`);
}

function buildGitEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  const now = new Date().toISOString();
  return { ...environment, ...IDENTITY, GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now };
}
