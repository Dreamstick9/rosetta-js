import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, PROJECT_ROOT } from "./config.js";
import { buildChildEnvironment } from "./environment.js";
import { IGNORED_DIRECTORIES } from "./tools/files.js";
import { writeDimLine } from "./ui.js";

const CHECK_TIMEOUT_MS = CONFIG.timeouts.testCheckSeconds * 1000;
const FAILURE_TAIL_LINES = CONFIG.agent.failureTailLines;
const NPM_PLACEHOLDER_TEST = "no test specified";
const VENV_PYTHON = ".venv/bin/python";
const MAX_SNAPSHOT_ENTRIES = 20_000;
const SNAPSHOT_SKIPPED_DIRECTORIES = new Set([...IGNORED_DIRECTORIES, "__pycache__", ".pytest_cache", ".rosetta"]);

export function takeProjectSnapshot(root = PROJECT_ROOT) {
  const snapshot = new Map();
  const pendingDirectories = [root];
  let entryCount = 0;
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of readDirectory(directory)) {
      entryCount++;
      if (entryCount > MAX_SNAPSHOT_ENTRIES) return null;
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile()) snapshot.set(fullPath, describeFile(fullPath));
      if (entry.isDirectory() && !SNAPSHOT_SKIPPED_DIRECTORIES.has(entry.name)) pendingDirectories.push(fullPath);
    }
  }
  return snapshot;
}

function readDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function describeFile(file) {
  try {
    const stats = fs.statSync(file);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "unreadable";
  }
}

export function snapshotsDiffer(before, after) {
  if (!before || !after || before.size !== after.size) return true;
  for (const [file, description] of after) {
    if (before.get(file) !== description) return true;
  }
  return false;
}

export function countChangedFiles(before, after) {
  if (!before || !after) return null;
  let count = 0;
  for (const [file, description] of after) {
    if (before.get(file) !== description) count++;
  }
  for (const file of before.keys()) {
    if (!after.has(file)) count++;
  }
  return count;
}

export function findTestCommand(root = PROJECT_ROOT) {
  if (hasNpmTestScript(root)) return "npm test --silent";
  if (isPythonProject(root)) return findPythonTestCommand(root);
  if (exists(root, "Cargo.toml")) return "cargo test";
  if (exists(root, "go.mod")) return "go test ./...";
  return null;
}

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function hasNpmTestScript(root) {
  if (!exists(root, "package.json")) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const testScript = packageJson.scripts?.test ?? "";
    return testScript !== "" && !testScript.includes(NPM_PLACEHOLDER_TEST);
  } catch {
    return false;
  }
}

function isPythonProject(root) {
  return exists(root, "pytest.ini") || exists(root, "pyproject.toml") || exists(root, "tests");
}

function findPythonTestCommand(root) {
  const python = exists(root, VENV_PYTHON) ? VENV_PYTHON : "python3";
  const pytestCheck = spawnSync(python, ["-c", "import pytest"], { cwd: root });
  if (pytestCheck.status === 0) return `${python} -m pytest -q`;
  return `${python} -m unittest discover`;
}

export async function runDoneCheck(command, signal, root = PROJECT_ROOT) {
  const result = await runCheckCommand(command, signal, CHECK_TIMEOUT_MS, root);
  signal.throwIfAborted();
  writeDimLine(`check: ${command} ${result.passed ? "✓" : "✗"}`);
  const failureMessage = `I ran \`${command}\` after your changes and it failed. Last lines of output:\n${result.tail}\n\nPlease fix the problem.`;
  return { passed: result.passed, tail: result.tail, failureMessage };
}

export function runCheckCommand(command, signal, timeoutMs, root = PROJECT_ROOT) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: root, env: buildChildEnvironment(), signal, timeout: timeoutMs, killSignal: "SIGKILL" });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("error", (error) => (output += `\n${error.message}`));
    child.on("close", (exitCode) => {
      if (exitCode === null) output += `\n[the command was stopped (timeout ${timeoutMs / 1000}s or interrupt)]`;
      resolve({ passed: exitCode === 0, tail: lastLines(output, FAILURE_TAIL_LINES) });
    });
  });
}

function lastLines(text, count) {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
