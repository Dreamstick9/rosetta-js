import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG, PROJECT_ROOT } from "../config.js";

const PATH_PROPERTY = { type: "string", description: "Path relative to the project root, or an absolute path." };
const CONTENT_PROPERTY = { type: "string", description: "Full file content." };
const DEFAULT_LIST_DEPTH = CONFIG.tools.listDepth;
const DEFAULT_READ_LIMIT = CONFIG.tools.readLineLimit;

export const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".venv", "target"]);

export const FILE_TOOLS = [
  fileTool("list_files", "List files and directories. Directories end with '/'. Ignored folders are listed but not opened.", {
    path: { type: "string", description: "Directory relative to the project root, or an absolute path. Default '.'." },
    depth: { type: "integer", description: `How many levels deep to list. Default ${DEFAULT_LIST_DEPTH}.` },
  }, [], listFiles),
  fileTool("read_file", "Read a text file. Lines are returned with line numbers.", {
    path: PATH_PROPERTY,
    offset: { type: "integer", description: "First line to read, starting at 1. Default 1." },
    limit: { type: "integer", description: `Maximum number of lines to read. Default ${DEFAULT_READ_LIMIT}.` },
  }, ["path"], readFile),
  fileTool("create_file", "Create a new file. Fails if the file already exists.", {
    path: PATH_PROPERTY,
    content: CONTENT_PROPERTY,
  }, ["path", "content"], createFile),
  fileTool("write_file", "Create or overwrite a file with the given content.", {
    path: PATH_PROPERTY,
    content: CONTENT_PROPERTY,
  }, ["path", "content"], writeFile),
  fileTool("edit_file", "Replace one exact, unique occurrence of old_text with new_text in a file.", {
    path: PATH_PROPERTY,
    old_text: { type: "string", description: "Exact text to find. Must match exactly once." },
    new_text: { type: "string", description: "Replacement text." },
  }, ["path", "old_text", "new_text"], editFile),
  fileTool("delete_file", "Delete a file.", { path: PATH_PROPERTY }, ["path"], deleteFile),
];

function fileTool(name, description, properties, required, run) {
  const definition = { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
  return { definition, run };
}

export function resolvePath(inputPath, root = PROJECT_ROOT) {
  return path.resolve(root, inputPath);
}

async function listFiles({ path: directory = ".", depth = DEFAULT_LIST_DEPTH }, { root }) {
  const absolute = resolvePath(directory, root);
  const entries = await collectEntries(absolute, Math.max(1, depth), root);
  if (entries.length === 0) return "(empty directory)";
  return entries.join("\n");
}

async function collectEntries(directory, depth, root) {
  const results = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const shownPath = path.relative(root, fullPath);
    if (!entry.isDirectory()) {
      results.push(shownPath);
      continue;
    }
    results.push(`${shownPath}/`);
    if (depth > 1 && !IGNORED_DIRECTORIES.has(entry.name)) {
      results.push(...(await collectEntries(fullPath, depth - 1, root)));
    }
  }
  return results;
}

async function readFile({ path: file, offset = 1, limit = DEFAULT_READ_LIMIT }, { root }) {
  const lines = (await fs.readFile(resolvePath(file, root), "utf8")).split("\n");
  const start = Math.max(1, offset);
  const selected = lines.slice(start - 1, start - 1 + Math.max(1, limit));
  if (selected.length === 0) return `(no lines at offset ${start}; the file has ${lines.length} lines)`;
  return selected.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join("\n");
}

async function createFile({ path: file, content }, { root }) {
  const absolute = resolvePath(file, root);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(absolute, content, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`${file} already exists; use write_file or edit_file`);
    throw error;
  }
  return `Created ${file}`;
}

async function writeFile({ path: file, content }, { root }) {
  const absolute = resolvePath(file, root);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return `Wrote ${file}`;
}

async function editFile({ path: file, old_text: oldText, new_text: newText }, { root }) {
  const absolute = resolvePath(file, root);
  const content = await fs.readFile(absolute, "utf8");
  if (oldText === "") throw new Error("old_text must not be empty");
  const matchCount = content.split(oldText).length - 1;
  if (matchCount === 0) throw new Error(`old_text was not found in ${file}`);
  if (matchCount > 1) throw new Error(`old_text matches ${matchCount} times in ${file}; include more surrounding text`);
  const index = content.indexOf(oldText);
  await fs.writeFile(absolute, content.slice(0, index) + newText + content.slice(index + oldText.length));
  return `Edited ${file}`;
}

async function deleteFile({ path: file }, { root }) {
  await fs.unlink(resolvePath(file, root));
  return `Deleted ${file}`;
}
