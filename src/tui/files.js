import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IGNORED_DIRECTORIES } from "../tools/files.js";

const MAX_FILES = 20_000;
const CACHE_MS = 10_000;

let cache = { root: null, files: [], at: 0 };

export function listProjectFiles(root) {
  if (cache.root === root && Date.now() - cache.at < CACHE_MS) return cache.files;
  cache = { root, files: readWithRipgrep(root) ?? walk(root), at: Date.now() };
  return cache.files;
}

function readWithRipgrep(root) {
  const result = spawnSync("rg", ["--files"], { cwd: root, encoding: "utf8", maxBuffer: 32_000_000 });
  if (result.error || (result.status !== 0 && !result.stdout)) return null;
  return result.stdout.split("\n").filter(Boolean).slice(0, MAX_FILES).sort();
}

function walk(root) {
  const files = [];
  const pending = [""];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const relative = pending.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(child);
      else files.push(child);
    }
  }
  return files;
}

export function rankFiles(files, query, limit) {
  if (!query) return files.slice(0, limit).map((file) => ({ path: file, positions: [] }));
  const scored = [];
  for (const file of files) {
    const match = scoreMatch(file, query.toLowerCase());
    if (match) scored.push(match);
  }
  return scored.sort((first, second) => second.score - first.score || first.path.length - second.path.length).slice(0, limit);
}

function scoreMatch(file, query) {
  const lower = file.toLowerCase();
  const baseStart = lower.lastIndexOf("/") + 1;
  const positions = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of query) {
    const index = lower.indexOf(char, from);
    if (index === -1) return null;
    score += index === previous + 1 ? 5 : 1;
    if (index === baseStart || "/_-.".includes(lower[index - 1] ?? "/")) score += 3;
    positions.push(index);
    previous = index;
    from = index + 1;
  }
  if (lower.slice(baseStart).includes(query)) score += 10;
  return { path: file, positions, score };
}
