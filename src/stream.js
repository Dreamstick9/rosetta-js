const DATA_PREFIX = "data:";
const DONE_MARKER = "[DONE]";

export async function parseStream(body, handlers) {
  const reply = { content: "", reasoning: "", reasoningField: null, toolCalls: [], usage: null, finishReason: null };
  for await (const data of readServerSentEvents(body, handlers.onData)) {
    const chunk = parseChunk(data);
    if (!chunk) continue;
    if (chunk.error) throw createStreamError(chunk.error);
    if (chunk.usage) reply.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) reply.finishReason = choice.finish_reason;
    if (choice?.delta) applyDelta(reply, choice.delta, handlers);
  }
  reply.toolCalls = reply.toolCalls.filter(Boolean).map(normalizeToolCall);
  return reply;
}

async function* readServerSentEvents(body, onData) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    onData();
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith(DATA_PREFIX)) continue;
      const data = line.slice(DATA_PREFIX.length).trim();
      if (data === DONE_MARKER) return;
      if (data) yield data;
    }
  }
}

function parseChunk(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function createStreamError(apiError) {
  const status = Number(apiError.code) || 0;
  const error = new Error(`API error in stream: ${JSON.stringify(apiError).slice(0, 300)}`);
  error.retryable = status === 429 || status >= 500;
  return error;
}

function applyDelta(reply, delta, handlers) {
  if (delta.content) {
    reply.content += delta.content;
    handlers.onText(delta.content);
  }
  const reasoning = readReasoning(delta);
  if (reasoning) {
    reply.reasoning += reasoning.text;
    reply.reasoningField ??= reasoning.field;
    handlers.onReasoning(reasoning.text);
  }
  for (const part of delta.tool_calls ?? []) addToolCallPart(reply.toolCalls, part);
}

function readReasoning(delta) {
  if (delta.reasoning) return { field: "reasoning", text: delta.reasoning };
  if (delta.reasoning_content) return { field: "reasoning_content", text: delta.reasoning_content };
  return null;
}

function addToolCallPart(toolCalls, part) {
  const index = part.index ?? 0;
  if (!toolCalls[index]) toolCalls[index] = { id: "", name: "", arguments: "" };
  const call = toolCalls[index];
  if (part.id) call.id = part.id;
  if (part.function?.name) call.name += part.function.name;
  if (part.function?.arguments) call.arguments += part.function.arguments;
}

function normalizeToolCall(call, index) {
  const normalized = { id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || "{}" };
  try {
    normalized.args = JSON.parse(normalized.arguments);
  } catch {
    normalized.argumentsError = `invalid JSON in arguments for ${call.name}: ${call.arguments.slice(0, 200)}. Retry with valid JSON.`;
    normalized.arguments = "{}";
  }
  return normalized;
}

export function buildAssistantMessage(reply) {
  const message = { role: "assistant", content: reply.content };
  if (reply.reasoningField) message[reply.reasoningField] = reply.reasoning;
  if (reply.toolCalls.length > 0) message.tool_calls = reply.toolCalls.map(toApiToolCall);
  return message;
}

function toApiToolCall(call) {
  return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
}
