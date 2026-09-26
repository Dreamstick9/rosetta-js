import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const STATE_FOLDER = ".rosetta";
const EXCLUDE_LINE = ".rosetta/";

let preparedRoot = null;

export function statePath(name) {
  const folder = path.join(PROJECT_ROOT, STATE_FOLDER);
  if (preparedRoot !== PROJECT_ROOT) {
    fs.mkdirSync(folder, { recursive: true });
    excludeFromRepository();
    preparedRoot = PROJECT_ROOT;
  }
  return path.join(folder, name);
}

export function readStateJson(name) {
  try {
    return JSON.parse(readStateText(name));
  } catch {
    return null;
  }
}

export function readStateText(name) {
  return readText(path.join(PROJECT_ROOT, STATE_FOLDER, name));
}

export function writeStateJson(name, value) {
  fs.writeFileSync(statePath(name), `${JSON.stringify(value, null, 2)}\n`);
}

function excludeFromRepository() {
  const gitFolder = path.join(PROJECT_ROOT, ".git");
  if (!isDirectory(gitFolder)) return;
  const excludeFile = path.join(gitFolder, "info", "exclude");
  const text = readText(excludeFile);
  if (text.split("\n").includes(EXCLUDE_LINE)) return;
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludeFile, `${separator}${EXCLUDE_LINE}\n`);
}

function isDirectory(folder) {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
