import { spawnSync } from "node:child_process";
import fs from "node:fs";

const MAX_DIFF_CHARS = 4000;
const EMPTY_FILE = "/dev/null";
const DIFF_ENVIRONMENT = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: EMPTY_FILE,
};

export function diffFiles(file, mainPath, workerPath) {
  const before = existingOrEmpty(mainPath);
  const after = existingOrEmpty(workerPath);
  const args = ["diff", "--no-index", "--no-color", "--no-prefix", "--", before, after];
  const result = spawnSync("git", args, { encoding: "utf8", env: DIFF_ENVIRONMENT, maxBuffer: 10_000_000 });
  if (result.error) return `[could not diff ${file}: ${result.error.message}]`;
  const text = relabel(result.stdout, before, after, file);
  return capText(text);
}

export function countChangedLines(mainPath, workerPath) {
  const args = ["diff", "--no-index", "--numstat", "--", existingOrEmpty(mainPath), existingOrEmpty(workerPath)];
  const result = spawnSync("git", args, { encoding: "utf8", env: DIFF_ENVIRONMENT });
  const [added, removed] = (result.stdout ?? "").split("\t");
  return (Number(added) || 0) + (Number(removed) || 0);
}

function existingOrEmpty(filePath) {
  if (fs.existsSync(filePath)) return filePath;
  return EMPTY_FILE;
}

function relabel(text, before, after, file) {
  let labelled = text;
  if (before !== EMPTY_FILE) labelled = labelled.replaceAll(before.slice(1), `main/${file}`);
  if (after !== EMPTY_FILE) labelled = labelled.replaceAll(after.slice(1), `worker/${file}`);
  return labelled.trimEnd();
}

function capText(text) {
  if (text.length <= MAX_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_DIFF_CHARS)}\n[diff cut at ${MAX_DIFF_CHARS} characters]`;
}
