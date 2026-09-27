import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { IGNORED_DIRECTORIES } from "../tools/files.js";

const SCAN_DEPTH = 3;
const MAX_SCANNED_ENTRIES = 5000;

export function scanProject() {
  const names = new Set();
  const extensions = new Set();
  const pending = [{ directory: PROJECT_ROOT, depth: 1 }];
  let scanned = 0;
  while (pending.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
    const { directory, depth } = pending.pop();
    for (const entry of readDirectory(directory)) {
      scanned++;
      if (depth === 1) names.add(entry.name);
      if (entry.isFile()) extensions.add(path.extname(entry.name));
      if (entry.isDirectory() && depth < SCAN_DEPTH && !IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
      }
    }
  }
  return { names, extensions };
}

function readDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function hasMarker(scan, marker) {
  if (marker.startsWith("*.")) return scan.extensions.has(marker.slice(1));
  return scan.names.has(marker);
}
