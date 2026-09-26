import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG, PROJECT_ROOT } from "../config.js";
import { IGNORED_DIRECTORIES, resolvePath } from "./files.js";

const MAX_MATCHES = CONFIG.tools.maxSearchMatches;
const MAX_LINE_LENGTH = CONFIG.tools.maxSearchLineLength;
const MAX_FILE_BYTES = 1_000_000;
const RIPGREP_BUFFER_BYTES = 10_000_000;
const HAS_RIPGREP = spawnSync("rg", ["--version"]).status === 0;
const runFile = promisify(execFile);

export const searchTool = {
  definition: {
    type: "function",
    function: {
      name: "search",
      description: `Search file contents with a regular expression. Returns 'file:line: text', at most ${MAX_MATCHES} matches.`,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "File or directory to search, relative to the project root or absolute. Default '.'." },
        },
        required: ["pattern"],
      },
    },
  },
  run: search,
};

async function search({ pattern, path: target = "." }) {
  const absolute = resolvePath(target);
  const matches = HAS_RIPGREP ? await searchWithRipgrep(pattern, absolute) : await searchWithWalk(pattern, absolute);
  if (matches.length === 0) return "No matches.";
  const lines = matches.slice(0, MAX_MATCHES);
  if (matches.length > MAX_MATCHES) lines.push(`[stopped at ${MAX_MATCHES} matches]`);
  return lines.join("\n");
}

async function searchWithRipgrep(pattern, absolute) {
  try {
    const { stdout } = await runFile("rg", ripgrepArguments(pattern, absolute), { cwd: PROJECT_ROOT, maxBuffer: RIPGREP_BUFFER_BYTES });
    return parseRipgrepOutput(stdout);
  } catch (error) {
    if (error.code === 1) return [];
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return parseRipgrepOutput(error.stdout);
    throw new Error(`search failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function ripgrepArguments(pattern, absolute) {
  const args = ["--line-number", "--no-heading", "--with-filename", "--color", "never", "--hidden"];
  for (const directory of IGNORED_DIRECTORIES) args.push("--glob", `!${directory}`);
  args.push("--regexp", pattern);
  args.push(path.relative(PROJECT_ROOT, absolute) || ".");
  return args;
}

function parseRipgrepOutput(stdout) {
  const matches = [];
  for (const line of stdout.split("\n")) {
    const parts = /^(.+?):(\d+):(.*)$/.exec(line);
    if (parts) matches.push(formatMatch(parts[1].replace(/^\.\//, ""), parts[2], parts[3]));
    if (matches.length > MAX_MATCHES) break;
  }
  return matches;
}

async function searchWithWalk(pattern, absolute) {
  const regex = createRegex(pattern);
  const matches = [];
  for await (const file of walkFiles(absolute)) {
    await addFileMatches(file, regex, matches);
    if (matches.length > MAX_MATCHES) break;
  }
  return matches;
}

function createRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`invalid regular expression: ${error.message}`);
  }
}

async function* walkFiles(target) {
  const stats = await fs.stat(target);
  if (stats.isFile()) {
    yield target;
    return;
  }
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(target, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) yield* walkFiles(fullPath);
    if (entry.isFile()) yield fullPath;
  }
}

async function addFileMatches(file, regex, matches) {
  const stats = await fs.stat(file);
  if (stats.size > MAX_FILE_BYTES) return;
  const content = await fs.readFile(file, "utf8");
  if (content.includes("\0")) return;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && matches.length <= MAX_MATCHES; i++) {
    if (regex.test(lines[i])) matches.push(formatMatch(path.relative(PROJECT_ROOT, file), i + 1, lines[i]));
  }
}

function formatMatch(file, lineNumber, text) {
  return `${file}:${lineNumber}: ${text.trim().slice(0, MAX_LINE_LENGTH)}`;
}
