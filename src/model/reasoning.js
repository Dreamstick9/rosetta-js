export const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_details"];

let preferredField = null;

export function preferReasoningField(field) {
  preferredField = REASONING_FIELDS.includes(field) ? field : null;
}

export function takeReasoningDelta(reply, delta) {
  reply.reasoningField ??= [preferredField, ...REASONING_FIELDS].find((field) => field && hasReasoning(delta[field]));
  const value = delta[reply.reasoningField];
  if (!hasReasoning(value)) return false;
  if (reply.reasoningField === "reasoning_details") addDetails(reply, value);
  else reply.reasoning += value;
  return true;
}

function hasReasoning(value) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.length > 0;
}

function addDetails(reply, details) {
  reply.reasoningDetails ??= [];
  for (const detail of details) {
    const previous = reply.reasoningDetails.find((known) => known.index === detail.index && known.type === detail.type);
    if (previous && typeof detail.text === "string") previous.text += detail.text;
    else reply.reasoningDetails.push({ ...detail });
    reply.reasoning += detail.text ?? "";
  }
}

export function reasoningEcho(reply) {
  if (!reply.reasoningField || !reply.reasoning && !reply.reasoningDetails) return {};
  if (reply.reasoningField === "reasoning_details") return { reasoning_details: reply.reasoningDetails };
  return { [reply.reasoningField]: reply.reasoning };
}

export function dropReasoning(messages) {
  return messages.map((message) => {
    if (message.role !== "assistant" || !REASONING_FIELDS.some((field) => field in message)) return message;
    const copy = { ...message };
    for (const field of REASONING_FIELDS) delete copy[field];
    return copy;
  });
}

export class EffortPolicy {
  constructor({ base, escalated, accepted }) {
    this.base = accepted ? base || null : null;
    this.escalated = accepted ? escalated || this.base : null;
    this.reason = null;
  }

  escalate(reason) {
    if (this.escalated && this.escalated !== this.base) this.reason = reason;
  }

  next() {
    const reason = this.reason;
    this.reason = null;
    return { effort: reason ? this.escalated : this.base, reason };
  }
}
