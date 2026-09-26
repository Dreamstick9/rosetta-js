import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export const TOOL_DEFINITIONS = [
  tool("list_files", "List files and directories under a path. Directories end with '/'.", {
    path: { type: "string", description: "Directory path relative to the working directory. Default '.'." },
    depth: { type: "integer", description: "How many levels deep to list. Default 2." },
  }, []),
  tool("read_file", "Read a text file. Lines are returned with line numbers.", {
    path: { type: "string", description: "File path relative to the working directory." },
    offset: { type: "integer", description: "First line to read, starting at 1. Default 1." },
    limit: { type: "integer", description: "Maximum number of lines to read. Default 2000." },
  }, ["path"]),
  tool("create_file", "Create a new file. Fails if the file already exists.", {
    path: { type: "string", description: "File path relative to the working directory." },
    content: { type: "string", description: "Full file content." },
  }, ["path", "content"]),
  tool("write_file", "Create or overwrite a file with the given content.", {
    path: { type: "string", description: "File path relative to the working directory." },
    content: { type: "string", description: "Full file content." },
  }, ["path", "content"]),
  tool("edit_file", "Replace one exact, unique occurrence of old_text with new_text in a file.", {
    path: { type: "string", description: "File path relative to the working directory." },
    old_text: { type: "string", description: "Exact text to find. Must match exactly once." },
    new_text: { type: "string", description: "Replacement text." },
  }, ["path", "old_text", "new_text"]),
  tool("delete_file", "Delete a file.", {
    path: { type: "string", description: "File path relative to the working directory." },
  }, ["path"]),
];

const HANDLERS = {
  list_files: listFiles,
  read_file: readFile,
  create_file: createFile,
  write_file: writeFile,
  edit_file: editFile,
  delete_file: deleteFile,
};

function tool(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export async function runTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`unknown tool '${name}'. Available tools: ${Object.keys(HANDLERS).join(", ")}`);
  checkRequiredArgs(name, args);
  return handler(args);
}

function checkRequiredArgs(name, args) {
  const definition = TOOL_DEFINITIONS.find((entry) => entry.function.name === name).function;
  const missing = definition.parameters.required.filter((key) => typeof args[key] !== "string");
  if (missing.length) throw new Error(`missing string argument(s) for ${name}: ${missing.join(", ")}`);
}

async function resolveInsideRoot(relativePath) {
  const absolute = path.resolve(ROOT, relativePath);
  if (!isInsideRoot(absolute) || !isInsideRoot(await realPathOfNearestExisting(absolute))) {
    throw new Error(`path '${relativePath}' is outside the working directory`);
  }
  return absolute;
}

function isInsideRoot(absolute) {
  const relative = path.relative(ROOT, absolute);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realPathOfNearestExisting(absolute) {
  try {
    const realRoot = await fs.realpath(ROOT);
    return path.join(ROOT, path.relative(realRoot, await fs.realpath(absolute)));
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : realPathOfNearestExisting(parent);
  }
}

async function listFiles({ path: dir = ".", depth = 2 }) {
  const absolute = await resolveInsideRoot(dir);
  const entries = await collectEntries(absolute, Math.max(1, depth));
  return entries.length ? entries.join("\n") : "(empty directory)";
}

async function collectEntries(dir, depth) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const shown = path.relative(ROOT, full) || ".";
    if (!entry.isDirectory()) results.push(shown);
    else {
      results.push(`${shown}/`);
      if (depth > 1) results.push(...(await collectEntries(full, depth - 1)));
    }
  }
  return results;
}

async function readFile({ path: file, offset = 1, limit = 2000 }) {
  const lines = (await fs.readFile(await resolveInsideRoot(file), "utf8")).split("\n");
  const start = Math.max(1, offset);
  const selected = lines.slice(start - 1, start - 1 + Math.max(1, limit));
  if (!selected.length) return `(no lines at offset ${start}; file has ${lines.length} lines)`;
  return selected.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join("\n");
}

async function createFile({ path: file, content }) {
  const absolute = await resolveInsideRoot(file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(absolute, content, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`${file} already exists; use write_file or edit_file`);
    throw error;
  }
  return `Created ${file}`;
}

async function writeFile({ path: file, content }) {
  const absolute = await resolveInsideRoot(file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return `Wrote ${file}`;
}

async function editFile({ path: file, old_text: oldText, new_text: newText }) {
  const absolute = await resolveInsideRoot(file);
  const content = await fs.readFile(absolute, "utf8");
  const matches = content.split(oldText).length - 1;
  if (!oldText || matches === 0) throw new Error(`old_text was not found in ${file}`);
  if (matches > 1) throw new Error(`old_text matches ${matches} times in ${file}; include more surrounding text`);
  const index = content.indexOf(oldText);
  await fs.writeFile(absolute, content.slice(0, index) + newText + content.slice(index + oldText.length));
  return `Edited ${file}`;
}

async function deleteFile({ path: file }) {
  await fs.unlink(await resolveInsideRoot(file));
  return `Deleted ${file}`;
}
