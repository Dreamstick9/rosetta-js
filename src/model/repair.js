import { extractTextCalls, readArguments } from "./extract.js";

const NAME_ALIASES = {
  read: "read_file", readfile: "read_file", cat: "read_file", view: "read_file", open_file: "read_file", view_file: "read_file",
  write: "write_file", writefile: "write_file", save_file: "write_file",
  create: "create_file", new_file: "create_file",
  edit: "edit_file", str_replace: "edit_file", replace: "edit_file", replace_in_file: "edit_file", apply_edit: "edit_file",
  delete: "delete_file", rm: "delete_file", remove_file: "delete_file",
  ls: "list_files", list: "list_files", list_dir: "list_files", list_directory: "list_files",
  grep: "search", rg: "search", find: "search", search_files: "search", grep_search: "search", search_code: "search",
  shell: "bash", run: "bash", sh: "bash", exec: "bash", execute: "bash", terminal: "bash", run_command: "bash", run_shell: "bash", command: "bash",
};
const ARGUMENT_ALIASES = {
  path: ["file_path", "filepath", "file", "filename", "file_name", "directory", "dir"],
  command: ["cmd", "script", "bash", "shell", "code"],
  pattern: ["query", "regex", "search", "grep", "text"],
  content: ["contents", "text", "code", "file_text", "data", "body"],
  old_text: ["old_string", "old_str", "old", "search", "find", "original"],
  new_text: ["new_string", "new_str", "new", "replace", "replacement"],
};

let callCount = 0;

export function repairReply(reply, toolDefinitions) {
  const schemas = new Map(toolDefinitions.map((tool) => [tool.function.name, tool.function.parameters]));
  const isToolName = (name) => schemas.has(resolveToolName(name, schemas));
  const repairs = [];
  let content = reply.content;
  let rawCalls = reply.toolCalls.map((call) => ({ id: call.id, name: call.name, ...readArguments(call.arguments) }));
  if (rawCalls.length === 0) {
    const found = extractTextCalls(reply.content, isToolName);
    rawCalls = found.calls;
    if (found.calls.length > 0) {
      content = found.rest;
      repairs.push(found.insideThink ? `call inside <think> (${found.format})` : `call in text (${found.format})`);
    }
  }
  const calls = rawCalls.map((call) => repairCall(call, schemas, repairs));
  return { content, calls, repairs };
}

function repairCall(call, schemas, repairs) {
  const name = resolveToolName(call.name, schemas);
  if (name !== call.name) repairs.push(`tool name ${call.name} → ${name}`);
  if (call.repaired || call.argumentsRepaired) repairs.push(`JSON arguments of ${name}`);
  const repaired = { id: call.id || `call_${++callCount}`, name };
  if (call.argumentsError) return { ...repaired, args: {}, argumentsError: `${name}: ${call.argumentsError}` };
  const args = fixArguments(call.args, schemas.get(name), name, repairs);
  return { ...repaired, args, arguments: JSON.stringify(args) };
}

export function resolveToolName(name, schemas) {
  if (schemas.has(name)) return name;
  const normalized = String(name)
    .replace(/^functions[.:]/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  if (schemas.has(normalized)) return normalized;
  const alias = NAME_ALIASES[normalized] ?? NAME_ALIASES[normalized.replace(/_/g, "")];
  return alias && schemas.has(alias) ? alias : name;
}

function fixArguments(args, schema, name, repairs) {
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const fixed = { ...args };
  for (const [key, property] of Object.entries(schema.properties)) {
    if (fixed[key] === undefined) renameAlias(fixed, key, schema, name, repairs);
    if (fixed[key] === null) delete fixed[key];
    const coerced = coerceValue(fixed[key], property.type);
    if (coerced === fixed[key]) continue;
    fixed[key] = coerced;
    repairs.push(`${name}.${key} as ${property.type}`);
  }
  return fixed;
}

function renameAlias(args, key, schema, name, repairs) {
  const alias = (ARGUMENT_ALIASES[key] ?? []).find((candidate) => args[candidate] !== undefined && !schema.properties[candidate]);
  if (!alias) return;
  args[key] = args[alias];
  delete args[alias];
  repairs.push(`${name} argument ${alias} → ${key}`);
}

function coerceValue(value, type) {
  if (value === undefined || value === null) return value;
  if (type === "string" && typeof value !== "string") return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  if (type === "integer" && typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return value;
}
