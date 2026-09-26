import { parseJsonLoose } from "./json-repair.js";

const THINK_BLOCK = /<think>([\s\S]*?)(?:<\/think>|$)/g;
const TAGGED_CALL = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
const FUNCTION_CALL = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
const FUNCTION_PARAMETER = /<parameter=([\w-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
const INVOKE_CALL = /<[^<>]*invoke name="([\w.-]+)">([\s\S]*?)(?:<\/[^<>]*invoke>|$)/g;
const INVOKE_PARAMETER = /<[^<>]*parameter name="([\w-]+)"([^>]*)>([\s\S]*?)<\/[^<>]*parameter>/g;
const ARG_PAIR = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
const FENCED_BLOCK = /```[\w-]*[ \t]*\n([\s\S]*?)```/g;
const BARE_CALL_START = /\{\s*["']?(?:name|tool|tool_name|function)["']?\s*:/g;
const NAME_KEYS = ["name", "tool", "tool_name"];
const ARGUMENT_KEYS = ["arguments", "args", "parameters", "input"];
const FINDERS = [findTaggedCalls, findFunctionCalls, findInvokeCalls, findFencedCalls, findBareCalls];

export function extractTextCalls(text, isToolName) {
  const outside = text.replace(THINK_BLOCK, "");
  const found = findCalls(outside, isToolName);
  if (found.calls.length > 0) return { ...found, insideThink: false };
  const inside = [...text.matchAll(THINK_BLOCK)].map((match) => match[1]).join("\n");
  return { ...findCalls(inside, isToolName), rest: outside.trim(), insideThink: true };
}

function findCalls(text, isToolName) {
  for (const finder of FINDERS) {
    const matches = finder(text).filter((match) => match.call && (finder.explicit || isToolName(match.call.name)));
    if (matches.length === 0) continue;
    const rest = matches.reduce((remaining, match) => remaining.replace(match.span, ""), text);
    return { calls: matches.map((match) => match.call), rest: rest.trim(), format: finder.format };
  }
  return { calls: [], rest: text.trim(), format: null };
}

function findTaggedCalls(text) {
  return [...text.matchAll(TAGGED_CALL)].map((match) => {
    const body = match[1];
    return { span: match[0], call: readTaggedBody(body) };
  });
}
findTaggedCalls.format = "<tool_call>";
findTaggedCalls.explicit = true;

function readTaggedBody(body) {
  const functionMatch = [...body.matchAll(FUNCTION_CALL)][0];
  if (functionMatch) return readFunctionCall(functionMatch);
  if (!body.includes("<arg_key>")) return readCallObject(body);
  const args = Object.fromEntries([...body.matchAll(ARG_PAIR)].map((pair) => [pair[1].trim(), pair[2]]));
  return { name: body.split(/[\n<]/)[0].trim(), args };
}

function findFunctionCalls(text) {
  return [...text.matchAll(FUNCTION_CALL)].map((match) => ({ span: match[0], call: readFunctionCall(match) }));
}
findFunctionCalls.format = "<function=…>";
findFunctionCalls.explicit = true;

function readFunctionCall(match) {
  const args = {};
  for (const parameter of match[2].matchAll(FUNCTION_PARAMETER)) args[parameter[1]] = parameter[2];
  return { name: match[1], args };
}

function findInvokeCalls(text) {
  return [...text.matchAll(INVOKE_CALL)].map((match) => {
    const args = {};
    for (const [, key, attributes, value] of match[2].matchAll(INVOKE_PARAMETER)) {
      args[key] = /string="false"/.test(attributes) ? parseJsonLoose(value)?.value ?? value : value;
    }
    return { span: match[0], call: { name: match[1], args } };
  });
}
findInvokeCalls.format = "<invoke>";
findInvokeCalls.explicit = true;

function findFencedCalls(text) {
  return [...text.matchAll(FENCED_BLOCK)].map((match) => ({ span: match[0], call: readCallObject(match[1]) }));
}
findFencedCalls.format = "```json block";

function findBareCalls(text) {
  const matches = [];
  for (const start of text.matchAll(BARE_CALL_START)) {
    if (matches.some((match) => start.index < match.end)) continue;
    const span = sliceBalanced(text, start.index);
    matches.push({ span, call: readCallObject(span), end: start.index + span.length });
  }
  return matches;
}
findBareCalls.format = "JSON in text";

function sliceBalanced(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if ((char === "}" || char === "]") && --depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function readCallObject(text) {
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed.value !== "object" || parsed.value === null) return readNameOnly(text);
  const object = parsed.value.function && typeof parsed.value.function === "object" ? parsed.value.function : parsed.value;
  const name = NAME_KEYS.map((key) => object[key]).find((value) => typeof value === "string") ?? stringOrNull(object.function);
  if (!name) return null;
  const rawArguments = ARGUMENT_KEYS.map((key) => object[key]).find((value) => value !== undefined) ?? {};
  return { name, ...readArguments(rawArguments), repaired: parsed.repaired };
}

function readNameOnly(text) {
  const name = text.match(/["']?(?:name|tool)["']?\s*:\s*["']([\w.-]+)["']/)?.[1];
  if (!name) return null;
  return { name, argumentsError: `could not parse the arguments of ${name}: ${text.slice(0, 200)}` };
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

export function readArguments(rawArguments) {
  if (typeof rawArguments !== "string") return { args: rawArguments };
  if (!rawArguments.trim()) return { args: {} };
  const parsed = parseJsonLoose(rawArguments);
  if (parsed) return { args: parsed.value, argumentsRepaired: parsed.repaired };
  return { argumentsError: `invalid JSON in arguments: ${rawArguments.slice(0, 200)}. Retry with valid JSON.` };
}
