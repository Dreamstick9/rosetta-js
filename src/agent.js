import { streamChat } from "./model.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";
import { estimateTokens, isOverThreshold, rebuildConversation, stubOldToolResults, truncateOutput } from "./context.js";

const SYSTEM_PROMPT = `You are a coding agent working in the user's current working directory.
Use the tools to inspect and change files. All paths are relative to the working directory.
Read a file before editing it. Prefer edit_file for small changes and write_file for rewrites.
Keep replies short and say what you changed when you are done.`;

const SYSTEM_MESSAGE = { role: "system", content: SYSTEM_PROMPT };
const PREFIX_TOKENS = estimateTokens(SYSTEM_PROMPT) + estimateTokens(TOOL_DEFINITIONS);
const FILE_TOOLS = new Set(["read_file", "create_file", "write_file", "edit_file", "delete_file"]);

export class Agent {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.messages = [SYSTEM_MESSAGE];
    this.originalTask = null;
    this.touchedFiles = new Set();
    this.usageMark = null;
  }

  async send(userText, ui) {
    this.originalTask ??= userText;
    this.currentRequest = userText;
    this.messages.push({ role: "user", content: userText });
    const stats = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimated: false };
    while (true) {
      this.compactIfNeeded(ui);
      const reply = await this.requestReply(ui, stats);
      if (!reply.toolCalls.length) return stats;
      for (const call of reply.toolCalls) await this.runToolCall(call, ui);
    }
  }

  async requestReply(ui, stats) {
    const promptEstimate = this.estimateContextTokens();
    const reply = await streamChat(this.config, this.messages, TOOL_DEFINITIONS, ui.onText);
    reply.toolCalls = reply.toolCalls.filter(Boolean).map(sanitizeToolCall);
    if (!reply.content && !reply.toolCalls.length) ui.onEmptyReply();
    this.messages.push(assistantMessage(reply));
    this.recordUsage(reply, promptEstimate, stats);
    return reply;
  }

  recordUsage(reply, promptEstimate, stats) {
    const usage = reply.usage;
    if (!usage) {
      stats.estimated = true;
      stats.inputTokens += promptEstimate;
      stats.outputTokens += estimateTokens(reply.content) + estimateTokens(reply.toolCalls);
      return;
    }
    stats.inputTokens += usage.prompt_tokens ?? 0;
    stats.outputTokens += usage.completion_tokens ?? 0;
    stats.cachedTokens += usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
    this.usageMark = { tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0), messageCount: this.messages.length };
  }

  async runToolCall(call, ui) {
    let output;
    let ok = true;
    try {
      const args = parseArguments(call);
      output = await runTool(call.name, args);
      if (FILE_TOOLS.has(call.name)) this.touchedFiles.add(args.path);
    } catch (error) {
      ok = false;
      output = `Error: ${error.message}`;
    }
    ui.onToolCall(call.name, summarizeArguments(call), ok ? null : output);
    this.messages.push({ role: "tool", tool_call_id: call.id, content: truncateOutput(output) });
  }

  estimateContextTokens() {
    if (!this.usageMark) return PREFIX_TOKENS + estimateTokens(this.messages.slice(1));
    return this.usageMark.tokens + estimateTokens(this.messages.slice(this.usageMark.messageCount));
  }

  compactIfNeeded(ui) {
    const before = this.estimateContextTokens();
    if (!isOverThreshold(before, this.config.maxContextTokens)) return;
    this.usageMark = null;
    this.messages = stubOldToolResults(this.messages);
    let method = "stubbed old tool results";
    if (isOverThreshold(this.estimateContextTokens(), this.config.maxContextTokens)) {
      this.messages = rebuildConversation(this.messages, {
        originalTask: this.originalTask,
        currentRequest: this.currentRequest,
        touchedFiles: this.touchedFiles,
        maxContextTokens: this.config.maxContextTokens,
      });
      method = "rebuilt conversation";
    }
    ui.onCompact(before, this.estimateContextTokens(), method);
  }
}

function sanitizeToolCall(call, index) {
  const id = call.id || `call_${index}`;
  try {
    JSON.parse(call.arguments || "{}");
    return { ...call, id, arguments: call.arguments || "{}" };
  } catch {
    return { ...call, id, arguments: "{}", invalidArguments: call.arguments };
  }
}

function parseArguments(call) {
  if (call.invalidArguments !== undefined) {
    throw new Error(`invalid JSON in arguments for ${call.name}: ${call.invalidArguments.slice(0, 200)}. Retry with valid JSON.`);
  }
  const args = JSON.parse(call.arguments);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be a JSON object");
  return args;
}

function assistantMessage(reply) {
  const message = { role: "assistant", content: reply.content || (reply.toolCalls.length ? null : "") };
  if (reply.toolCalls.length) {
    message.tool_calls = reply.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return message;
}

function summarizeArguments(call) {
  try {
    const args = JSON.parse(call.arguments);
    return String(args.path ?? "");
  } catch {
    return "";
  }
}
