import { CONFIG } from "../config.js";
import { getRole } from "../roles.js";
import { findLessonsAbout, formatLessons } from "../lessons.js";

const MAX_RESULT_LINES = CONFIG.agents.maxResultLines;
const SUBAGENT_RULES = `You are a sub-agent of a coding agent. You get one sub-task; the main agent only sees your final reply.
Use the tools to inspect, change and test the project. Paths are relative to your working folder, or absolute.
Some calls are blocked by a safety policy, and some tools in the list are not available to your role. When a call is refused, choose another way.
The bash tool runs in one persistent shell. Work fast: read what you need in few calls.
Your final reply is cut to its first ${MAX_RESULT_LINES} lines, so put the facts that matter first.`;

export function buildSystemMessage(roleName) {
  return { role: "system", content: `${SUBAGENT_RULES}\n\n${getRole(roleName).prompt}` };
}

export function buildBriefing({ item, root, planItems }) {
  const sections = [`# Sub-task (${item.agentId})\n${item.prompt}`, describeFolder(item.role, root)];
  if (item.files.length > 0) sections.push(`Files: ${item.files.join(", ")}`);
  const plan = planItems.filter((planItem) => mentionsAny(`${planItem.text} ${planItem.check ?? ""}`, item.files));
  if (plan.length > 0) sections.push(`# Plan items for this sub-task\n${plan.map((planItem) => `- ${planItem.text}`).join("\n")}`);
  const earlier = [...item.predecessors.map(describePredecessor), ...item.earlierResults.map(describeEarlierResult)];
  if (earlier.length > 0) sections.push(`# Results of the tasks this one depends on\n${earlier.join("\n\n")}`);
  const lessons = item.lessons ?? findLessonsAbout(item.files, CONFIG.agents.lessonsPerAgent);
  if (lessons.length > 0) sections.push(`# Lessons from earlier failed attempts\n${formatLessons(lessons, true)}`);
  return sections.join("\n\n");
}

function describeFolder(roleName, root) {
  if (roleName === "worker") return `Working folder: ${root} (your private copy of the project; your changes are merged back file by file when you finish).`;
  return `Working folder: ${root} (read-only: do not change any file).`;
}

function mentionsAny(text, files) {
  return files.some((file) => text.includes(file.split("/").at(-1)));
}

function describePredecessor(predecessor) {
  return `## ${predecessor.agentId ?? predecessor.id}${predecessor.id ? ` (id ${predecessor.id})` : ""}\n${predecessor.result}`;
}

function describeEarlierResult({ id, result }) {
  return `## ${id}\n${result}`;
}
