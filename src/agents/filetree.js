import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LINKED_DIRECTORIES = new Set(["node_modules", ".venv", "venv", "target"]);
export const SKIPPED_DIRECTORIES = new Set([".git", ".rosetta", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".next", ".gradle"]);

export function isLeftOut(name) {
  return LINKED_DIRECTORIES.has(name) || SKIPPED_DIRECTORIES.has(name);
}

export function fingerprint(filePath) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink()) return `symlink:${fs.readlinkSync(filePath)}`;
  if (!stats.isFile()) return null;
  return createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
}

export function scanTree(root) {
  const manifest = new Map();
  const pendingDirectories = [root];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (isLeftOut(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pendingDirectories.push(fullPath);
      else addToManifest(manifest, root, fullPath);
    }
  }
  return manifest;
}

function addToManifest(manifest, root, fullPath) {
  const print = fingerprint(fullPath);
  if (print) manifest.set(path.relative(root, fullPath), print);
}
