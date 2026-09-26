import fs from "node:fs";
import path from "node:path";
import { WORKSPACES_ROOT, canonicalPath } from "../paths.js";
import { diffFiles } from "./filediff.js";
import { LINKED_DIRECTORIES, fingerprint, isLeftOut, scanTree } from "./filetree.js";

const SAFE_NAME_PATTERN = /^[\w.-]+$/;

export function createWorkspace({ root, runId, agentId }) {
  checkName("runId", runId);
  checkName("agentId", agentId);
  const mainRoot = canonicalPath(root);
  const target = path.join(WORKSPACES_ROOT, runId, agentId);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyProject(mainRoot, target);
  const dir = canonicalPath(target);
  return { runId, agentId, root: mainRoot, dir, base: scanTree(dir) };
}

function checkName(label, value) {
  if (typeof value === "string" && SAFE_NAME_PATTERN.test(value) && value !== "." && value !== "..") return;
  throw new Error(`${label} must be a simple name made of letters, digits, '.', '_' or '-'`);
}

function copyProject(mainRoot, target) {
  const linked = [];
  const filter = (source) => keepForCopy(source, mainRoot, linked);
  fs.cpSync(mainRoot, target, { recursive: true, filter, verbatimSymlinks: true });
  for (const source of linked) fs.symlinkSync(source, path.join(target, path.relative(mainRoot, source)));
}

function keepForCopy(source, mainRoot, linked) {
  if (source === mainRoot) return true;
  const name = path.basename(source);
  if (LINKED_DIRECTORIES.has(name)) linked.push(source);
  return !isLeftOut(name);
}

export function changedFiles(workspace) {
  const current = scanTree(workspace.dir);
  const changes = [];
  for (const [file, print] of current) {
    if (!workspace.base.has(file)) changes.push({ file, change: "added" });
    else if (workspace.base.get(file) !== print) changes.push({ file, change: "modified" });
  }
  for (const file of workspace.base.keys()) {
    if (!current.has(file)) changes.push({ file, change: "deleted" });
  }
  return changes.sort((first, second) => first.file.localeCompare(second.file));
}

export function mergeWorkspace(workspace, mainRoot = workspace.root) {
  const applied = [];
  const conflicts = [];
  for (const { file } of changedFiles(workspace)) {
    const conflict = mergeFile(workspace, mainRoot, file);
    if (conflict) conflicts.push(conflict);
    else applied.push(file);
  }
  return { applied, conflicts };
}

function mergeFile(workspace, mainRoot, file) {
  const mainPath = path.join(mainRoot, file);
  const workerPath = path.join(workspace.dir, file);
  const mainPrint = fingerprint(mainPath);
  if (mainPrint === fingerprint(workerPath)) return null;
  if (mainPrint !== (workspace.base.get(file) ?? null)) return { file, diff: diffFiles(file, mainPath, workerPath) };
  try {
    applyWorkerVersion(workerPath, mainPath);
    return null;
  } catch (error) {
    return { file, diff: `[could not apply the worker's version: ${error.message}]` };
  }
}

function applyWorkerVersion(workerPath, mainPath) {
  fs.rmSync(mainPath, { force: true });
  if (fingerprint(workerPath) === null) return;
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.cpSync(workerPath, mainPath, { verbatimSymlinks: true });
}

export function removeWorkspace(workspace) {
  fs.rmSync(workspace.dir, { recursive: true, force: true });
}
