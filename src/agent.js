import { requestCompletion } from "./model.js";
import { ModelAdapter } from "./model/adapter.js";
import { dropReasoning } from "./model/reasoning.js";
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
const NUDGE_MESSAGE = "Your reply was empty. Continue the task: call a tool, or give your final answer.";
const FILE_TOOLS = new Set(["read_file", "create_file", "write_file", "edit_file", "delete_file"]);
const CHANGING_TOOLS = new Set(["create_file", "write_file", "edit_file", "delete_file", "bash"]);

export class Agent {
  constructor({ config, trace }) {
    this.config = config;
    this.trace = trace;
    this.doneCheckEnabled = true;
    this.systemMessage = null;
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
    this.messages.push({ role: "user", content: userText });
    const stats = { cost: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    const task = { stats, outcome: "done", nudges: 0, checkRounds: 0, changedFiles: false, snapshot: takeProjectSnapshot() };
    for (let turn = 1; turn <= this.config.maxTurns; turn++) {
      stats.turns = turn;
      if (this.trace.totals.cost >= this.config.maxSessionUsd) return this.stopForBudget(stats);
      const reply = await this.requestReply(signal, stats);
      if (reply.followUp) {
        this.messages.push({ role: "user", content: reply.followUp });
        continue;
      }
      if (reply.calls.length > 0) {
        await this.runTools(reply.calls, signal, task);
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
    this.systemMessage = this.adapter.systemMessage(prompt.message.content);
    this.messages.unshift(this.systemMessage);
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

  async runTools(calls, signal, task) {
    const results = await runToolCalls(calls, { signal });
    const recorded = results.map((result) => ({ ...result, content: this.recordToolResult(result, task) }));
    this.messages.push(...this.adapter.resultMessages(recorded));
    signal.throwIfAborted();
  }

  recordToolResult({ call, output, status, ms }, task) {
    const content = truncateOutput(output);
    const summary = summarizeToolArguments(call.args);
    writeToolLine({ name: call.name, summary, status, output });
    const reason = status === "blocked" ? output : undefined;
    this.trace.recordToolCall({ name: call.name, args: summary, ms, bytes: Buffer.byteLength(content), status, reason });
    if (status !== "ok") return content;
    if (FILE_TOOLS.has(call.name)) this.touchedFiles.add(call.args.path);
    if (CHANGING_TOOLS.has(call.name)) task.changedFiles = true;
    return content;
  }

  async findFollowUp(reply, signal, task) {
    if (reply.content.trim()) return this.checkWork(signal, task);
    if (task.nudges >= MAX_NUDGES) {
      writeError("The model returned an empty reply.");
      task.outcome = "empty_reply";
      return null;
    }
    task.nudges++;
    writeDimLine(`repaired: ${reply.reasoning ? "reasoning-only" : "empty"} reply → nudge`);
    this.adapter.escalate("empty reply");
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
    this.adapter.escalate("tests failed");
    return check.failureMessage;
  }

  compactIfNeeded() {
    const before = this.estimateContextTokens();
    if (!needsCompaction(before, this.config.maxContextTokens)) return;
    this.messages = dropReasoning(compactMessages(this.messages, {
      originalTask: this.originalTask,
      currentRequest: this.currentRequest,
      touchedFiles: this.touchedFiles,
      maxContextTokens: this.config.maxContextTokens,
      toolTokens: TOOL_TOKENS,
    }));
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
