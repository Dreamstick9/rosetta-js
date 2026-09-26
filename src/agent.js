import { requestCompletion } from "./model.js";
import { buildAssistantMessage } from "./stream.js";
import { TOOL_DEFINITIONS, runToolCalls, summarizeToolArguments } from "./tools/index.js";
import { compactMessages, estimateTokens, isPrefixStable, needsCompaction, truncateOutput } from "./context.js";
import { findTestCommand, runDoneCheck, snapshotsDiffer, takeProjectSnapshot } from "./checks.js";
import { readTokenCounts } from "./trace.js";
import { CONFIG } from "./config.js";
import { buildSessionPrompt, describeLoadedContext } from "./prompt.js";
import { createReplyPrinter, writeDimLine, writeError, writeToolLine } from "./ui.js";

const TOOL_TOKENS = estimateTokens(TOOL_DEFINITIONS);
const MAX_NUDGES = CONFIG.agent.maxEmptyReplyNudges;
const MAX_CHECK_ROUNDS = CONFIG.agent.maxCheckRounds;
const NUDGE_MESSAGE = "Please continue.";
const FILE_TOOLS = new Set(["read_file", "create_file", "write_file", "edit_file", "delete_file"]);
const CHANGING_TOOLS = new Set(["create_file", "write_file", "edit_file", "delete_file", "bash"]);

export class Agent {
  constructor({ config, trace }) {
    this.config = config;
    this.trace = trace;
    this.doneCheckEnabled = true;
    this.systemMessage = null;
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
    this.messages.push({ role: "user", content: userText });
    const stats = { cost: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    const task = { stats, outcome: "done", nudges: 0, checkRounds: 0, changedFiles: false, snapshot: takeProjectSnapshot() };
    for (let turn = 1; turn <= this.config.maxTurns; turn++) {
      stats.turns = turn;
      if (this.trace.totals.cost >= this.config.maxSessionUsd) return this.stopForBudget(stats);
      const reply = await this.requestReply(signal, stats);
      if (reply.toolCalls.length > 0) {
        await this.runTools(reply.toolCalls, signal, task);
        continue;
      }
      const followUp = await this.findFollowUp(reply, signal, task);
      if (!followUp) return { ...stats, outcome: task.outcome };
      this.messages.push({ role: "user", content: followUp });
    }
    writeError(`Stopped: this task reached maxTurns (${this.config.maxTurns} model calls).`);
    return { ...stats, outcome: "max_turns" };
  }

  loadSystemMessage() {
    if (this.systemMessage) return;
    const prompt = buildSessionPrompt();
    this.systemMessage = prompt.message;
    this.messages.unshift(prompt.message);
    this.trace.recordPromptLoad(prompt.loaded);
    writeDimLine(describeLoadedContext(prompt.loaded));
  }

  stopForBudget(stats) {
    writeError(`Stopped: the session cost reached maxSessionUsd ($${this.config.maxSessionUsd}).`);
    return { ...stats, outcome: "budget" };
  }

  async requestReply(signal, stats) {
    this.compactIfNeeded();
    if (!isPrefixStable(this.messages[0], TOOL_DEFINITIONS)) {
      writeError("Error: the system prompt or tool list changed, so prompt caching will break.");
    }
    const promptEstimate = this.estimateContextTokens();
    const startedAt = Date.now();
    const reply = await requestCompletion({
      config: this.config,
      messages: this.messages,
      tools: TOOL_DEFINITIONS,
      handlers: createReplyPrinter(),
      signal,
      onRetry: (message) => writeDimLine(`[retry] ${message}`),
    });
    this.messages.push(buildAssistantMessage(reply));
    this.recordUsage(reply, promptEstimate, Date.now() - startedAt, stats);
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

  async runTools(calls, signal, task) {
    const results = await runToolCalls(calls, { signal, trace: this.trace, taskText: this.originalTask });
    for (const result of results) this.recordToolResult(result, task);
    signal.throwIfAborted();
  }

  recordToolResult({ call, output, line, status, ms }, task) {
    const content = truncateOutput(output);
    const summary = summarizeToolArguments(call.args);
    writeToolLine({ name: call.name, summary, status, output, line });
    const reason = status === "blocked" ? output : undefined;
    this.trace.recordToolCall({ name: call.name, args: summary, ms, bytes: Buffer.byteLength(content), status, reason });
    this.messages.push({ role: "tool", tool_call_id: call.id, content });
    if (status !== "ok") return;
    if (FILE_TOOLS.has(call.name)) this.touchedFiles.add(call.args.path);
    if (CHANGING_TOOLS.has(call.name)) task.changedFiles = true;
  }

  async findFollowUp(reply, signal, task) {
    if (reply.content.trim()) return this.checkWork(signal, task);
    if (task.nudges >= MAX_NUDGES) {
      writeError("The model returned an empty reply.");
      task.outcome = "empty_reply";
      return null;
    }
    task.nudges++;
    writeDimLine("[empty reply; asking the model to continue]");
    return NUDGE_MESSAGE;
  }

  async checkWork(signal, task) {
    if (!this.doneCheckEnabled || !task.changedFiles) return null;
    task.changedFiles = false;
    const snapshot = takeProjectSnapshot();
    const filesChanged = snapshotsDiffer(task.snapshot, snapshot);
    task.snapshot = snapshot;
    if (!filesChanged) return null;
    const testCommand = findTestCommand();
    if (!testCommand) return null;
    const check = await runDoneCheck(testCommand, signal);
    if (check.passed) return null;
    if (task.checkRounds >= MAX_CHECK_ROUNDS) {
      task.outcome = "tests_failing";
      return null;
    }
    task.checkRounds++;
    return check.failureMessage;
  }

  compactIfNeeded() {
    const before = this.estimateContextTokens();
    if (!needsCompaction(before, this.config.maxContextTokens)) return;
    this.messages = compactMessages(this.messages, {
      originalTask: this.originalTask,
      currentRequest: this.currentRequest,
      touchedFiles: this.touchedFiles,
      maxContextTokens: this.config.maxContextTokens,
      toolTokens: TOOL_TOKENS,
    });
    this.usageMark = null;
    const after = this.estimateContextTokens();
    writeDimLine(`[context compacted: ${before} → ${after} tokens]`);
    this.trace.recordCompaction({ before, after });
  }

  estimateContextTokens() {
    if (!this.usageMark) return TOOL_TOKENS + estimateTokens(this.messages);
    return this.usageMark.tokens + estimateTokens(this.messages.slice(this.usageMark.messageCount));
  }
}
