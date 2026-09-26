import fs from "node:fs";

const BIG_OUTPUT_BYTES = 8000;
const CHECK_LINE = /^check: .* [✓✗]$/gm;

export function readTrace(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(parseLine).filter(Boolean);
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function summarizeTrace(entries, stdout) {
  const models = entries.filter((entry) => entry.type === "model");
  const tools = entries.filter((entry) => entry.type === "tool");
  return {
    outcome: entries.findLast((entry) => entry.type === "task")?.outcome ?? "no_result",
    cost: sum(models, "cost"),
    inputTokens: sum(models, "inputTokens"),
    cachedTokens: sum(models, "cachedTokens"),
    outputTokens: sum(models, "outputTokens"),
    modelCalls: models.length,
    modelSeconds: sum(models, "ms") / 1000,
    toolCalls: tools.length,
    toolSeconds: sum(tools, "ms") / 1000,
    toolsByName: countBy(tools, (entry) => entry.name),
    toolErrors: tools.filter((entry) => entry.status && entry.status !== "ok").length,
    bigOutputs: tools.filter((entry) => entry.bytes >= BIG_OUTPUT_BYTES).length,
    compactions: entries.filter((entry) => entry.type === "compaction").length,
    skills: unique(entries.filter(isSkill).map(skillName)),
    subAgents: entries.filter(isSubAgent).length,
    attempts: Math.max(entries.filter(isAttempt).length, (stdout.match(CHECK_LINE) ?? []).length),
    blocked: entries.filter(isBlocked).length,
  };
}

function isSkill(entry) {
  return entry.type === "skill" || (entry.type === "tool" && /skill/i.test(entry.name ?? ""));
}

function skillName(entry) {
  return String(entry.skill ?? entry.skillName ?? entry.args ?? entry.name);
}

function isSubAgent(entry) {
  if (["subagent", "sub_agent", "agent"].includes(entry.type)) return true;
  return entry.type === "tool" && /agent|delegate|subtask/i.test(entry.name ?? "");
}

function isAttempt(entry) {
  return ["check", "attempt", "done_check"].includes(entry.type);
}

function isBlocked(entry) {
  return entry.type === "blocked" || entry.status === "blocked" || entry.blocked === true;
}

function sum(entries, field) {
  return entries.reduce((total, entry) => total + (Number(entry[field]) || 0), 0);
}

function countBy(entries, keyOf) {
  const counts = {};
  for (const entry of entries) counts[keyOf(entry)] = (counts[keyOf(entry)] ?? 0) + 1;
  return counts;
}

function unique(values) {
  return [...new Set(values)];
}
