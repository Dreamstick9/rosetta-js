import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HARNESS_ROOT, setProjectRoot } from "./config.js";
import { writeDimLine } from "./ui.js";

export const DEFAULT_WORK_FOLDER = "/tmp/rjs-work";
const FOLDER_VARIABLES = ["REPO", "TARGET_REPO", "REPO_PATH"];

export function openWorkingFolder(repositoryMayBeCloned) {
  const choice = chooseStartFolder(repositoryMayBeCloned);
  const problem = describeFolderProblem(choice.folder);
  if (problem) return `${choice.source}: ${problem}`;
  enterWorkingFolder(choice.folder, choice.source);
  return null;
}

export function enterWorkingFolder(folder, source) {
  setProjectRoot(folder);
  writeDimLine(`Working folder: ${process.cwd()} (${source})`);
}

function chooseStartFolder(repositoryMayBeCloned) {
  const choice = findWorkingFolder();
  if (choice.source !== "REPO_PATH" || fs.existsSync(choice.folder) || !repositoryMayBeCloned) return choice;
  writeDimLine(`REPO_PATH ${choice.folder} does not exist yet; it is cloned when the task names a GitHub repository.`);
  return findDefaultFolder();
}

function findWorkingFolder() {
  const name = FOLDER_VARIABLES.find((candidate) => process.env[candidate]);
  if (name) return { folder: expandHome(process.env[name]), source: name };
  return findDefaultFolder();
}

function findDefaultFolder() {
  if (!isInsideHarness(process.cwd())) return { folder: process.cwd(), source: "current folder" };
  fs.mkdirSync(DEFAULT_WORK_FOLDER, { recursive: true });
  return { folder: DEFAULT_WORK_FOLDER, source: "default" };
}

function describeFolderProblem(folder) {
  if (!fs.existsSync(folder)) return `${folder} does not exist.`;
  if (!fs.statSync(folder).isDirectory()) return `${folder} is not a folder.`;
  if (isInsideHarness(folder)) return `${folder} is the rosetta-js folder itself; point it at the project to fix.`;
  return null;
}

export function isInsideHarness(folder) {
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

export function expandHome(folder) {
  if (folder === "~" || folder.startsWith("~/")) return path.join(os.homedir(), folder.slice(1));
  return path.resolve(folder);
}
