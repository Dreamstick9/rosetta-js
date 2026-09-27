import { FILE_TOOLS } from "./files.js";
import { searchTool } from "./search.js";
import { MAIN_SHELL, bashTool } from "./shell.js";
import { skillTool } from "./skill.js";
import { WEB_TOOLS } from "./web.js";
import { PROJECT_ROOT } from "../config.js";
import { todoTool } from "./todo.js";
import { giveUpTool } from "./give_up.js";
import { checkToolCall, describeBlock } from "../policy.js";
import { describeToolRefusal } from "../roles.js";

const TOOLS = [...FILE_TOOLS, searchTool, bashTool, skillTool, todoTool, giveUpTool, ...WEB_TOOLS];
const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search", "skill", "web_search", "web_fetch"]);
const SUMMARY_LENGTH = 60;
const INTERRUPTED_RESULT = "Interrupted by the user.";

export const TOOL_DEFINITIONS = TOOLS.map((tool) => tool.definition);

export async function runToolCalls(calls, callerContext) {
  const context = { ...callerContext, root: callerContext.root ?? PROJECT_ROOT, shell: callerContext.shell ?? MAIN_SHELL };
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
    const tool = findTool(call.name);
    const refusal = describeToolRefusal(context.role, call.name);
    if (refusal) throw new Error(refusal);
    checkArguments(tool.definition.function, call.args);
    const blockedReason = checkToolCall(call.name, call.args, context.shell.currentCwd(), context.root);
    if (blockedReason) return { call, output: describeBlock(blockedReason), status: "blocked", ms: 0 };
    const result = await tool.run(call.args, context);
    const { output, line } = typeof result === "string" ? { output: result } : result;
    return { call, output, line, status: "ok", ms: Date.now() - startedAt };
  } catch (error) {
    return { call, output: `Error: ${error.message}`, status: "error", ms: Date.now() - startedAt };
  }
}

function findTool(name) {
  const tool = TOOLS.find((candidate) => candidate.definition.function.name === name);
  if (tool) return tool;
  const names = TOOLS.map((candidate) => candidate.definition.function.name);
  throw new Error(`unknown tool '${name}'. Available tools: ${names.join(", ")}`);
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
  const value = args?.path ?? args?.pattern ?? args?.command ?? args?.name ?? args?.url ?? args?.query ?? args?.action ?? args?.reason ?? "";
  const text = String(value).replaceAll("\n", " ").trim();
  if (text.length <= SUMMARY_LENGTH) return text;
  return `${text.slice(0, SUMMARY_LENGTH)}…`;
}
