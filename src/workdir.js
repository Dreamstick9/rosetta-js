import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HARNESS_ROOT, setProjectRoot } from "./config.js";
import { readAnswer } from "./input.js";
import { writeDimLine, writeError } from "./ui.js";

const DEFAULT_WORK_FOLDER = "/tmp/rjs-work";
const FOLDER_QUESTION = "Which folder should I work on?";

export function findPresetFolder() {
  if (process.env.REPO) return { folder: expandHome(process.env.REPO), source: "REPO" };
  if (process.env.REPO_PATH) return { folder: expandHome(process.env.REPO_PATH), source: "REPO_PATH" };
  if (!isInsideHarness(process.cwd())) return { folder: process.cwd(), source: "current folder" };
  return null;
}

export function openPresetFolder({ folder, source }) {
  const problem = describeFolderProblem(folder);
  if (problem) return `${source}: ${problem}`;
  enterFolder(folder, source);
  return null;
}

export async function chooseWorkingFolder({ canAsk }) {
  if (!canAsk) return enterFolder(createFolder(DEFAULT_WORK_FOLDER), "default");
  const answer = await readAnswer(`${FOLDER_QUESTION} [${DEFAULT_WORK_FOLDER}]`);
  if (answer === null) return false;
  const folder = expandHome(answer.trim() || DEFAULT_WORK_FOLDER);
  if (isInsideHarness(folder)) {
    writeError(`${folder} is the rosetta-js folder itself; using ${DEFAULT_WORK_FOLDER} instead.`);
    return enterFolder(createFolder(DEFAULT_WORK_FOLDER), "default");
  }
  return enterFolder(createFolder(folder), "your answer");
}

function describeFolderProblem(folder) {
  if (!fs.existsSync(folder)) return `${folder} does not exist.`;
  if (!fs.statSync(folder).isDirectory()) return `${folder} is not a folder.`;
  if (isInsideHarness(folder)) return `${folder} is the rosetta-js folder itself; point it at the project to fix.`;
  return null;
}

function enterFolder(folder, source) {
  setProjectRoot(folder);
  writeDimLine(`Working folder: ${process.cwd()} (${source})`);
  return true;
}

function createFolder(folder) {
  fs.mkdirSync(folder, { recursive: true });
  return path.resolve(folder);
}

function isInsideHarness(folder) {
  const real = realPath(path.resolve(folder));
  const harness = realPath(HARNESS_ROOT);
  return real === harness || real.startsWith(`${harness}${path.sep}`);
}

function realPath(folder) {
  try {
    return fs.realpathSync(folder);
  } catch {
    return folder;
  }
}

function expandHome(folder) {
  if (folder === "~" || folder.startsWith("~/")) return path.join(os.homedir(), folder.slice(1));
  return path.resolve(folder);
}
