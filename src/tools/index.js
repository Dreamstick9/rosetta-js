import { FILE_TOOLS } from "./files.js";
import { searchTool } from "./search.js";
import { bashTool } from "./shell.js";

const TOOLS = [...FILE_TOOLS, searchTool, bashTool];
const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search"]);
const SUMMARY_LENGTH = 60;
const INTERRUPTED_RESULT = "Interrupted by the user.";

export const TOOL_DEFINITIONS = TOOLS.map((tool) => tool.definition);

export async function runToolCalls(calls, context) {
  const results = [];
  for (const batch of groupReadOnlyCalls(calls)) {
    if (context.signal.aborted) {
      results.push(...batch.map((call) => ({ call, output: INTERRUPTED_RESULT, status: "error", ms: 0 })));
      continue;
    }
    results.push(...(await Promise.all(batch.map((call) => runToolCall(call, context)))));
  }
  return results;
}

function groupReadOnlyCalls(calls) {
  const batches = [];
  for (const call of calls) {
    const lastBatch = batches.at(-1);
    const joinsLastBatch = lastBatch && isReadOnly(call) && isReadOnly(lastBatch[0]);
    if (joinsLastBatch) lastBatch.push(call);
    else batches.push([call]);
  }
  return batches;
}

function isReadOnly(call) {
  return READ_ONLY_TOOL_NAMES.has(call.name);
}

async function runToolCall(call, context) {
  const startedAt = Date.now();
  try {
    if (call.argumentsError) throw new Error(call.argumentsError);
    const output = await runTool(call.name, call.args, context);
    return { call, output, status: "ok", ms: Date.now() - startedAt };
  } catch (error) {
    return { call, output: `Error: ${error.message}`, status: "error", ms: Date.now() - startedAt };
  }
}

async function runTool(name, args, context) {
  const tool = TOOLS.find((candidate) => candidate.definition.function.name === name);
  if (!tool) {
    const names = TOOLS.map((candidate) => candidate.definition.function.name);
    throw new Error(`unknown tool '${name}'. Available tools: ${names.join(", ")}`);
  }
  checkArguments(tool.definition.function, args);
  return tool.run(args, context);
}

function checkArguments(definition, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`arguments for ${definition.name} must be a JSON object`);
  }
  const missing = definition.parameters.required.filter((key) => typeof args[key] !== "string");
  if (missing.length > 0) {
    throw new Error(`missing string argument(s) for ${definition.name}: ${missing.join(", ")}`);
  }
}

export function summarizeToolArguments(args) {
  const value = args?.path ?? args?.pattern ?? args?.command ?? "";
  const text = String(value).replaceAll("\n", " ").trim();
  if (text.length <= SUMMARY_LENGTH) return text;
  return `${text.slice(0, SUMMARY_LENGTH)}…`;
}
