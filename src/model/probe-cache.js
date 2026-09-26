import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_FILE = path.join(os.homedir(), ".cache", "rosetta-js", "probe.json");

export function readCachedProbe(key) {
  return readAll()[key] ?? null;
}

export function writeCachedProbe(key, profile) {
  try {
    const all = { ...readAll(), [key]: profile };
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify(all, null, 2)}\n`);
  } catch {
    return;
  }
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}
