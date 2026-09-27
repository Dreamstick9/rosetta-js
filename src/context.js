import { summarizeToolArguments } from "./tools/index.js";
import { CONFIG } from "./config.js";

const CHARS_PER_TOKEN = 4;
const MAX_TOOL_OUTPUT_BYTES = CONFIG.context.maxToolOutputBytes;
const COMPACT_START_SHARE = CONFIG.context.compactStartShare;
const COMPACT_TARGET_SHARE = CONFIG.context.compactTargetShare;
const KEPT_TOOL_RESULTS = CONFIG.context.keptToolResults;

const firstPrefixes = new Map();

export function isPrefixStable(systemMessage, toolDefinitions, owner = "main") {
  const prefix = JSON.stringify([systemMessage, toolDefinitions]);
  if (!firstPrefixes.has(owner)) firstPrefixes.set(owner, prefix);
  return prefix === firstPrefixes.get(owner);
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function truncateOutput(text, maxBytes = MAX_TOOL_OUTPUT_BYTES) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const headEnd = charStartAtOrBefore(bytes, Math.floor(maxBytes / 2));
  const tailStart = charStartAtOrAfter(bytes, bytes.length - Math.floor(maxBytes / 2));
  const omittedLines = bytes.subarray(headEnd, tailStart).toString("utf8").split("\n").length;
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return `${head}\n[${omittedLines} lines omitted]\n${tail}`;
}

function charStartAtOrBefore(bytes, index) {
  while (index > 0 && isContinuationByte(bytes[index])) index--;
  return index;
}

function charStartAtOrAfter(bytes, index) {
  while (index < bytes.length && isContinuationByte(bytes[index])) index++;
  return index;
}

function isContinuationByte(byte) {
  return (byte & 0xc0) === 0x80;
}

export function needsCompaction(tokens, maxContextTokens) {
  return tokens > maxContextTokens * COMPACT_START_SHARE;
}

export function compactMessages(messages, details) {
  const targetTokens = details.maxContextTokens * COMPACT_TARGET_SHARE;
  const stubbed = stubOldToolResults(messages);
  if (!details.forceSummary && estimateTokens(stubbed) + details.toolTokens <= targetTokens) return stubbed;
  return rebuildConversation(stubbed, details, targetTokens);
}

function stubOldToolResults(messages) {
  const toolIndexes = [];
  for (let i = 0; i < messages.length; i++) {
    if (isToolResult(messages[i])) toolIndexes.push(i);
  }
  const oldIndexes = new Set(toolIndexes.slice(0, -KEPT_TOOL_RESULTS));
  const labels = labelToolCalls(messages);
  return messages.map((message, index) => {
    if (!oldIndexes.has(index)) return message;
    return { ...message, content: `[old result of ${labels.get(message.tool_call_id) ?? "tool"} removed]` };
  });
}

function isToolResult(message) {
  return message.role === "tool" || message.role === "user" && message.content.startsWith("<tool_result");
}

function labelToolCalls(messages) {
  const labels = new Map();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const summary = summarizeToolArguments(parseArguments(call.function.arguments));
      labels.set(call.id, `${call.function.name} ${summary}`.trim());
    }
  }
  return labels;
}

function parseArguments(argumentsJson) {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return {};
  }
}

function rebuildConversation(messages, details, targetTokens) {
  const summary = { role: "user", content: buildSummary(details) };
  const fixedTokens = estimateTokens([messages[0], summary]) + details.toolTokens;
  const start = findRecentStart(messages, targetTokens - fixedTokens);
  return [messages[0], summary, ...messages.slice(start)];
}

function buildSummary({ originalTask, currentRequest, touchedFiles, planText }) {
  const sections = [
    "The conversation was compacted to save context.",
    `Original task:\n${originalTask}`,
    `Files touched so far: ${[...touchedFiles].join(", ") || "none"}`,
  ];
  if (currentRequest !== originalTask) sections.push(`Latest request:\n${currentRequest}`);
  if (planText) sections.push(planText);
  sections.push("The most recent messages follow.");
  return sections.join("\n\n");
}

function findRecentStart(messages, tokenBudget) {
  let start = messages.length - 1;
  let usedTokens = estimateTokens(messages[start]);
  while (start > 2 && usedTokens + estimateTokens(messages[start - 1]) <= tokenBudget) {
    start--;
    usedTokens += estimateTokens(messages[start]);
  }
  while (start > 1 && messages[start].role === "tool") start--;
  return start;
}
