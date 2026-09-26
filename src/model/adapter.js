import { createDialect } from "./dialects.js";
import { repairReply } from "./repair.js";
import { EffortPolicy, reasoningEcho } from "./reasoning.js";
import { getModelProfile } from "./prepare.js";
import { writeDimLine } from "../ui.js";

const MAX_CONTINUATIONS = 2;
const MAX_FORMAT_NUDGES = 1;
const CONTINUE_PROMPT = "Your reply was cut off by the output limit. Continue exactly where it stopped, without repeating anything.";
const FORMAT_PROMPT = "Your tool call could not be parsed. Write it again with valid JSON arguments, in the documented format.";
const UNPARSED_CALL = /<tool_call>|<function=/;

export class ModelAdapter {
  constructor(config, toolDefinitions) {
    const profile = getModelProfile(config);
    const { reasoningEffort, escalatedReasoningEffort } = profile.settings;
    this.tools = toolDefinitions;
    this.dialect = createDialect(profile.dialect, toolDefinitions);
    this.effort = new EffortPolicy({ base: reasoningEffort, escalated: escalatedReasoningEffort, accepted: profile.effortAccepted });
    this.pendingText = "";
    this.continuations = 0;
    this.formatNudges = 0;
    this.lastToolsFailed = false;
  }

  systemMessage(prompt) {
    return { role: "system", content: prompt + this.dialect.systemSuffix };
  }

  requestOptions() {
    const { effort, reason } = this.effort.next();
    if (reason) writeDimLine(`[reasoning effort ${effort}: ${reason}]`);
    const extra = {};
    if (effort) extra.reasoning_effort = effort;
    if (this.dialect.stop) extra.stop = this.dialect.stop;
    return { tools: this.dialect.requestTools, extra };
  }

  escalate(reason) {
    this.effort.escalate(reason);
  }

  readReply(raw) {
    const echo = reasoningEcho(raw);
    const text = this.pendingText + raw.content;
    if (raw.finishReason === "length" && this.continuations < MAX_CONTINUATIONS) return this.continueReply(raw, text, echo);
    const pending = this.pendingText;
    this.pendingText = "";
    this.continuations = 0;
    const repaired = repairReply({ content: text, toolCalls: raw.toolCalls }, this.tools);
    if (repaired.repairs.length > 0) writeDimLine(`repaired: ${repaired.repairs.join("; ")}`);
    const content = this.dialect.name === "native" ? dropPrefix(repaired.content, pending) : raw.content;
    const message = { ...this.dialect.assistantMessage(content, repaired.calls), ...echo };
    const reply = { message, calls: repaired.calls, content: repaired.content, reasoning: raw.reasoning, followUp: null };
    if (repaired.calls.length > 0) this.formatNudges = 0;
    else if (UNPARSED_CALL.test(repaired.content) && this.formatNudges < MAX_FORMAT_NUDGES) reply.followUp = this.nudgeFormat();
    return reply;
  }

  continueReply(raw, text, echo) {
    this.continuations++;
    this.pendingText = text;
    writeDimLine("repaired: reply cut off by the output limit → asking to continue");
    const message = { role: "assistant", content: raw.content, ...echo };
    return { message, calls: [], content: "", reasoning: raw.reasoning, followUp: CONTINUE_PROMPT };
  }

  nudgeFormat() {
    this.formatNudges++;
    writeDimLine("repaired: unparseable tool call → asking to resend");
    this.escalate("unparseable tool call");
    return FORMAT_PROMPT;
  }

  resultMessages(results) {
    const failed = results.some((result) => result.status !== "ok");
    if (failed && this.lastToolsFailed) this.escalate("repeated tool error");
    this.lastToolsFailed = failed;
    return this.dialect.resultMessages(results);
  }
}

function dropPrefix(text, prefix) {
  return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
