const CHARS_PER_TOKEN = 4;
const MAX_TOOL_OUTPUT_BYTES = 16000;
const COMPACT_THRESHOLD = 0.7;
const RECENT_BUDGET_SHARE = 0.3;
const KEPT_TOOL_RESULTS = 3;

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function truncateOutput(text, maxBytes = MAX_TOOL_OUTPUT_BYTES) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const headEnd = charStartAtOrBefore(bytes, Math.floor(maxBytes / 2));
  const tailStart = charStartAtOrAfter(bytes, bytes.length - Math.floor(maxBytes / 2));
  const omitted = bytes.subarray(headEnd, tailStart).toString("utf8").split("\n").length;
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return `${head}\n[${omitted} lines omitted]\n${tail}`;
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

export function isOverThreshold(tokens, maxContextTokens) {
  return tokens > maxContextTokens * COMPACT_THRESHOLD;
}

export function stubOldToolResults(messages) {
  const toolIndexes = messages.flatMap((message, index) => (message.role === "tool" ? [index] : []));
  const labels = toolCallLabels(messages);
  const oldIndexes = toolIndexes.slice(0, -KEPT_TOOL_RESULTS);
  return messages.map((message, index) =>
    oldIndexes.includes(index) ? { ...message, content: `[old result of ${labels.get(message.tool_call_id) ?? "tool"} removed]` } : message,
  );
}

function toolCallLabels(messages) {
  const labels = new Map();
  for (const call of messages.flatMap((message) => message.tool_calls ?? [])) {
    labels.set(call.id, `${call.function.name} ${pathArgument(call.function.arguments)}`.trim());
  }
  return labels;
}

function pathArgument(argumentsJson) {
  try {
    return JSON.parse(argumentsJson).path ?? "";
  } catch {
    return "";
  }
}

export function rebuildConversation(messages, { originalTask, currentRequest, touchedFiles, maxContextTokens }) {
  const start = recentStartIndex(messages, maxContextTokens * RECENT_BUDGET_SHARE);
  const recent = messages.slice(start);
  const lines = [
    "The conversation was compacted to save context.",
    `Original task:\n${originalTask}`,
    `Files touched so far: ${[...touchedFiles].join(", ") || "none"}`,
  ];
  if (!recent.some((message) => message.content === currentRequest)) lines.push(`Current request:\n${currentRequest}`);
  lines.push("The most recent messages follow.");
  return [messages[0], { role: "user", content: lines.join("\n\n") }, ...recent];
}

function recentStartIndex(messages, tokenBudget) {
  let start = messages.length - 1;
  let used = estimateTokens(messages[start]);
  while (start > 2 && used + estimateTokens(messages[start - 1]) <= tokenBudget) {
    start--;
    used += estimateTokens(messages[start]);
  }
  while (start > 1 && messages[start].role === "tool") start--;
  return start;
}
