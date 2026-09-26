import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";
import { buildGitEnvironment } from "./token.js";

const runFile = promisify(execFile);
const GIT_TIMEOUT_MS = CONFIG.intake.gitTimeoutSeconds * 1000;
const CLONE_DEPTH = String(CONFIG.intake.cloneDepth);
const DEFAULT_BRANCH_PATTERN = /^ref: refs\/heads\/(\S+)\s+HEAD$/m;

export async function cloneRepository({ owner, repo }, folder, token, signal) {
  if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) {
    throw new Error(`${folder} already exists and is not a checkout of ${owner}/${repo}`);
  }
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  const url = `https://github.com/${owner}/${repo}.git`;
  await runGit(["clone", "--depth", CLONE_DEPTH, "--", url, folder], null, token, signal);
}

export async function isCheckoutOf(folder, { owner, repo }) {
  if (!fs.existsSync(path.join(folder, ".git"))) return false;
  try {
    const { stdout } = await runGit(["remote", "get-url", "origin"], folder, null);
    return originMatches(stdout.trim(), owner, repo);
  } catch {
    return false;
  }
}

function originMatches(origin, owner, repo) {
  const expected = `github.com/${owner}/${repo}`.toLowerCase();
  const normalized = origin.toLowerCase().replace("github.com:", "github.com/").replace(/\/$/, "").replace(/\.git$/, "");
  const tail = normalized.slice(-expected.length - 1);
  return tail === `/${expected}` || tail === `@${expected}`;
}

export async function updateCheckout(folder, token, signal) {
  const { stdout } = await runGit(["ls-remote", "--symref", "origin", "HEAD"], folder, token, signal);
  const branch = stdout.match(DEFAULT_BRANCH_PATTERN)?.[1];
  if (!branch) throw new Error("could not find the default branch of origin");
  await runGit(["fetch", "--depth", CLONE_DEPTH, "origin", branch], folder, token, signal);
  await runGit(["checkout", "-B", branch, "FETCH_HEAD"], folder, null, signal);
  return branch;
}

function runGit(args, folder, token, signal) {
  const options = { env: buildGitEnvironment(token), timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", signal };
  if (folder) options.cwd = folder;
  return runFile("git", args, options);
}

export function describeGitError(error) {
  const lines = String(error.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) return lines.at(-1);
  if (error.killed) return `git was stopped after ${GIT_TIMEOUT_MS / 1000}s`;
  return error.message.split("\n")[0];
}
