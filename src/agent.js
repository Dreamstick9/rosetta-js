import path from "node:path";
import { requestCompletion } from "./model.js";
import { ModelAdapter } from "./model/adapter.js";
import { dropReasoning } from "./model/reasoning.js";
import { TOOL_DEFINITIONS, runToolCalls, summarizeToolArguments } from "./tools/index.js";
import { compactMessages, estimateTokens, isPrefixStable, needsCompaction, truncateOutput } from "./context.js";
import { readTokenCounts } from "./trace.js";
import { buildSessionPrompt, describeLoadedContext } from "./prompt.js";
import { TaskLoop } from "./attempts.js";
import { describeUnresumable, loadSession } from "./session.js";
import { addSkillNotes } from "./skills-internal/index.js";
import { digestOutput } from "./digest/index.js";
import { createReplyPrinter, writeDimLine, writeError, writeToolLine } from "./ui.js";

const TOOL_TOKENS = estimateTokens(TOOL_DEFINITIONS);
const FILE_TOOLS = new Set(["read_file", "create_file", "write_file", "edit_file", "delete_file"]);

export class Agent {
  constructor({ config, trace }) {
    this.config = config;
    this.trace = trace;
    this.doneCheckEnabled = true;
    this.systemMessage = null;
    this.loop = new TaskLoop(this);
    this.adapter = new ModelAdapter(config, TOOL_DEFINITIONS);
    this.reset();
  }

  reset() {
    this.messages = this.systemMessage ? [this.systemMessage] : [];
    this.originalTask = null;
    this.touchedFiles = new Set();
    this.usageMark = null;
  }

  async runTask(userText, signal) {
    this.loadSystemMessage();
    this.originalTask ??= userText;
    this.currentRequest = userText;
    this.addUserMessage(this.messages.length === 1 ? addSkillNotes(userText, this.config) : userText);
    return this.loop.runTask(userText, signal);
  }

  async resumeTask(signal) {
    const saved = loadSession();
    const problem = describeUnresumable(saved);
    if (problem) throw new Error(`Cannot resume: ${problem}.`);
    this.loadSystemMessage();
    this.originalTask = saved.task;
    this.currentRequest = saved.task;
    return this.loop.resume(saved, signal);
  }

  startConversation(text) {
    this.messages = [this.systemMessage, { role: "user", content: text }];
    this.touchedFiles = new Set();
    this.usageMark = null;
  }

  addUserMessage(text) {
    this.messages.push({ role: "user", content: text });
  }

  loadSystemMessage() {
    if (this.systemMessage) return;
    const prompt = buildSessionPrompt();
    this.systemMessage = this.adapter.systemMessage(prompt.message.content);
    this.messages.unshift(this.systemMessage);
    this.trace.recordPromptLoad(prompt.loaded);
    writeDimLine(describeLoadedContext(prompt.loaded));
  }

  async requestReply(signal, stats) {
    this.compactIfNeeded();
    if (!isPrefixStable(this.messages[0], TOOL_DEFINITIONS)) {
      writeError("Error: the system prompt or tool list changed, so prompt caching will break.");
    }
    const promptEstimate = this.estimateContextTokens();
    const startedAt = Date.now();
    const raw = await requestCompletion({
      config: this.config,
      messages: this.messages,
      ...this.adapter.requestOptions(),
      handlers: createReplyPrinter(),
      signal,
      onRetry: (message) => writeDimLine(`[retry] ${message}`),
    });
    const reply = this.adapter.readReply(raw);
    this.messages.push(reply.message);
    this.recordUsage(raw, promptEstimate, Date.now() - startedAt, stats);
    return reply;
  }

  recordUsage(reply, promptEstimate, ms, stats) {
    const tokens = readTokenCounts(reply.usage, promptEstimate, estimateTokens(reply.content + reply.reasoning));
    stats.cost += this.trace.recordModelCall({ ms, ...tokens, finishReason: reply.finishReason });
    stats.inputTokens += tokens.inputTokens;
    stats.cachedTokens += tokens.cachedTokens;
    stats.outputTokens += tokens.outputTokens;
    if (reply.usage) this.usageMark = { tokens: tokens.inputTokens + tokens.outputTokens, messageCount: this.messages.length };
  }

  async runTools(calls, signal) {
    const results = await runToolCalls(calls, { signal, loop: this.loop });
    const recorded = results.map((result) => ({ ...result, content: this.recordToolResult(result) }));
    this.messages.push(...this.adapter.resultMessages(recorded));
    signal.throwIfAborted();
    return results;
  }

  recordToolResult({ call, output, status, ms }) {
    const content = truncateOutput(call.name === "bash" ? digestOutput(call.args.command, output, this.outputDirectory()) : output);
    const summary = summarizeToolArguments(call.args);
    writeToolLine({ name: call.name, summary, status, output });
    const reason = status === "blocked" ? output : undefined;
    this.trace.recordToolCall({ name: call.name, args: summary, ms, bytes: Buffer.byteLength(content), status, reason });
    if (status === "ok" && FILE_TOOLS.has(call.name)) this.touchedFiles.add(call.args.path);
    return content;
  }

  compactIfNeeded() {
    if (!needsCompaction(this.estimateContextTokens(), this.config.maxContextTokens)) return;
    this.compact(false);
  }

  compact(forceSummary) {
    const before = this.estimateContextTokens();
    this.messages = dropReasoning(compactMessages(this.messages, {
      originalTask: this.originalTask,
      currentRequest: this.currentRequest,
      touchedFiles: this.touchedFiles,
      planText: this.loop.plan.items.length > 0 ? this.loop.plan.render() : null,
      forceSummary,
      maxContextTokens: this.config.maxContextTokens,
      toolTokens: TOOL_TOKENS,
    }));
    this.usageMark = null;
    const after = this.estimateContextTokens();
    writeDimLine(`[context compacted${forceSummary ? " at a plan milestone" : ""}: ${before} → ${after} tokens]`);
    this.trace.recordCompaction({ before, after });
  }

  outputDirectory() {
    return this.trace.file && path.join(path.dirname(this.trace.file), "out");
  }

  estimateContextTokens() {
    if (!this.usageMark) return TOOL_TOKENS + estimateTokens(this.messages);
    return this.usageMark.tokens + estimateTokens(this.messages.slice(this.usageMark.messageCount));
  }
}
