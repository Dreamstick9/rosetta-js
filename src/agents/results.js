import { CONFIG } from "../config.js";

const MAX_LINES = CONFIG.agents.maxResultLines;
const MAX_LINE_CHARS = CONFIG.agents.maxResultLineChars;

export function formatResult(item, run, changes, merge) {
  const header = `[${item.agentId} ${item.role} · ${run.outcome} · ${run.stats.turns} turns · $${run.stats.cost.toFixed(4)}]`;
  const lines = [header, ...trimLines(run.summary, MAX_LINES)];
  if (changes.length > 0) lines.push(`Changed files: ${changes.map(({ file, change }) => `${file} (${change})`).join(", ")}`);
  if (merge) lines.push(...describeMerge(merge));
  return lines.join("\n");
}

export function trimLines(text, maxLines) {
  const lines = text.split("\n").filter((line) => line.trim());
  const kept = lines.slice(0, maxLines).map(capLine);
  if (lines.length > maxLines) kept.push(`[${lines.length - maxLines} more lines cut]`);
  return kept;
}

function capLine(line) {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}…`;
}

function describeMerge({ applied, conflicts }) {
  const lines = [];
  if (applied.length > 0) lines.push(`Merged into main: ${applied.join(", ")}`);
  for (const conflict of conflicts) {
    lines.push(`Conflict in ${conflict.file}: main changed it since this worker started, so main's version was kept. Diff from main to the worker's version:\n${conflict.diff}`);
  }
  if (applied.length === 0 && conflicts.length === 0) lines.push("Nothing to merge.");
  return lines;
}

export function describeCheck(check, command) {
  if (!check) return "No test command found for a done-check.";
  if (check.passed) return `Done-check after merging: \`${command}\` passed.`;
  return `Done-check after merging: \`${command}\` failed. Last lines:\n${check.tail.split("\n").slice(-MAX_LINES).join("\n")}`;
}
