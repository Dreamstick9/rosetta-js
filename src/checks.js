import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, PROJECT_ROOT } from "./config.js";
import { IGNORED_DIRECTORIES } from "./tools/files.js";
import { writeDimLine } from "./ui.js";

const CHECK_TIMEOUT_MS = CONFIG.timeouts.testCheckSeconds * 1000;
const FAILURE_TAIL_LINES = CONFIG.agent.failureTailLines;
const NPM_PLACEHOLDER_TEST = "no test specified";
const VENV_PYTHON = ".venv/bin/python";
const MAX_SNAPSHOT_ENTRIES = 20_000;
const SNAPSHOT_SKIPPED_DIRECTORIES = new Set([...IGNORED_DIRECTORIES, "__pycache__", ".pytest_cache"]);

export function takeProjectSnapshot() {
  const snapshot = new Map();
  const pendingDirectories = [PROJECT_ROOT];
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

export function findTestCommand() {
  if (hasNpmTestScript()) return "npm test --silent";
  if (isPythonProject()) return findPythonTestCommand();
  if (exists("Cargo.toml")) return "cargo test";
  if (exists("go.mod")) return "go test ./...";
  return null;
}

function exists(relativePath) {
  return fs.existsSync(path.join(PROJECT_ROOT, relativePath));
}

function hasNpmTestScript() {
  if (!exists("package.json")) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    const testScript = packageJson.scripts?.test ?? "";
    return testScript !== "" && !testScript.includes(NPM_PLACEHOLDER_TEST);
  } catch {
    return false;
  }
}

function isPythonProject() {
  return exists("pytest.ini") || exists("pyproject.toml") || exists("tests");
}

function findPythonTestCommand() {
  const python = exists(VENV_PYTHON) ? VENV_PYTHON : "python3";
  const pytestCheck = spawnSync(python, ["-c", "import pytest"], { cwd: PROJECT_ROOT });
  if (pytestCheck.status === 0) return `${python} -m pytest -q`;
  return `${python} -m unittest discover`;
}

export async function runDoneCheck(command, signal) {
  const result = await runTestCommand(command, signal);
  signal.throwIfAborted();
  writeDimLine(`check: ${command} ${result.passed ? "✓" : "✗"}`);
  const failureMessage = `I ran \`${command}\` after your changes and it failed. Last lines of output:\n${result.tail}\n\nPlease fix the problem.`;
  return { passed: result.passed, failureMessage };
}

function runTestCommand(command, signal) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: PROJECT_ROOT, signal, timeout: CHECK_TIMEOUT_MS, killSignal: "SIGKILL" });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("error", (error) => (output += `\n${error.message}`));
    child.on("close", (exitCode) => {
      if (exitCode === null) output += `\n[the test command was stopped (timeout ${CHECK_TIMEOUT_MS / 1000}s or interrupt)]`;
      resolve({ passed: exitCode === 0, tail: lastLines(output, FAILURE_TAIL_LINES) });
    });
  });
}

function lastLines(text, count) {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
