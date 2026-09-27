import { takeReasoningDelta } from "./model/reasoning.js";
import { isQuotaError, quotaMessage } from "./model/errors.js";

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
  reply.toolCalls = reply.toolCalls.filter(Boolean);
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
  const details = JSON.stringify(apiError);
  if (isQuotaError(status, details)) return Object.assign(new Error(quotaMessage(status, details)), { retryable: false });
  const error = new Error(`API error in stream: ${details.slice(0, 300)}`);
  error.retryable = status === 429 || status >= 500;
  return error;
}

function applyDelta(reply, delta, handlers) {
  if (delta.content) {
    reply.content += delta.content;
    handlers.onText(delta.content);
  }
  if (takeReasoningDelta(reply, delta)) handlers.onReasoning(readReasoningText(delta[reply.reasoningField]));
  for (const part of delta.tool_calls ?? []) addToolCallPart(reply.toolCalls, part);
}

function addToolCallPart(toolCalls, part) {
  const index = part.index ?? 0;
  if (!toolCalls[index]) toolCalls[index] = { id: "", name: "", arguments: "" };
  const call = toolCalls[index];
  if (part.id) call.id = part.id;
  if (part.function?.name) call.name += part.function.name;
  if (part.function?.arguments) call.arguments += part.function.arguments;
}

function readReasoningText(value) {
  return typeof value === "string" ? value : "";
}
