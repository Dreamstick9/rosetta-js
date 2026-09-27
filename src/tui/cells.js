import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { countChanges, diffLines, renderDiffHunks } from "./diff.js";
import { parseInline } from "./markdown.js";
import { sanitize, span, spansWidth, style, textWidth, truncateSpans, wrapSpans } from "./text.js";

const DIM = style("dim");
const BOLD = style("bold");
const CYAN = style("cyan");
const RED = style("red");
const GREEN = style("green");
const YELLOW = style("yellow");
const BULLET = "• ";
const INDENT = [span("  ")];
const MAX_OUTPUT_LINES = 5;
const MAX_COMMAND_LINES = 4;
const MAX_USER_LINES = 40;
const DIFF_INDENT = "    ";
const FILE_VERBS = { create_file: "Creating", write_file: "Writing", edit_file: "Editing", delete_file: "Deleting" };
const FAILED_VERBS = { create_file: "Create", write_file: "Write", edit_file: "Edit", delete_file: "Delete" };

export function tildify(folder) {
  const home = os.homedir();
  if (folder === home || folder.startsWith(`${home}${path.sep}`)) return `~${folder.slice(home.length)}`;
  return folder;
}

export function displayPath(file) {
  const absolute = path.resolve(PROJECT_ROOT, String(file ?? "."));
  const relative = path.relative(PROJECT_ROOT, absolute);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return tildify(absolute);
}

export function formatTokens(count) {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

export function formatElapsed(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${rest}s`;
}

export function cachePercent(cachedTokens, inputTokens) {
  return inputTokens === 0 ? 0 : Math.round((cachedTokens / inputTokens) * 100);
}

function firstLine(text) {
  return sanitize(text).trim().split("\n")[0];
}

function wrapPlain(text, width, firstPrefix, restPrefix = INDENT, styleCode = "") {
  return sanitize(text).split("\n").flatMap((line, index) => wrapSpans([span(line, styleCode)], width, index === 0 ? firstPrefix : restPrefix, restPrefix));
}

export function boxLines(rows, width) {
  if (width < 12) return rows;
  const inner = Math.min(Math.max(...rows.map(spansWidth)), width - 4);
  const body = rows.map((row) => {
    const cut = truncateSpans(row, inner);
    return [span("│", DIM), span(" "), ...cut, span(" ".repeat(inner - spansWidth(cut) + 1)), span("│", DIM)];
  });
  return [[span(`╭${"─".repeat(inner + 2)}╮`, DIM)], ...body, [span(`╰${"─".repeat(inner + 2)}╯`, DIM)]];
}

export function headerCell({ version, model, directory, policy, keepChatting, notes }, width) {
  const rows = [
    [span(">_ ", DIM), span("Rosetta", BOLD), span(` (v${version})`, DIM)],
    [],
    [span("model:     ", DIM), span(model), span("   "), span("/model", CYAN), span(" to change", DIM)],
    [span("directory: ", DIM), span(directory)],
    [span("policy:    ", DIM), span(policy), span("   "), span("/approvals", CYAN), span(" to change", DIM)],
  ];
  const lines = boxLines(rows, width);
  for (const note of notes) lines.push(...wrapPlain(note, width, INDENT, INDENT, DIM));
  lines.push([], [span("  To get started, describe a task or try one of these commands:", DIM)], []);
  for (const [name, description] of INTRO_COMMANDS) lines.push(truncateSpans([span(`  /${name}`), span(` - ${description}`, DIM)], width));
  if (!keepChatting) {
    lines.push([]);
    lines.push(...wrapPlain("This session ends after one task (exitAfterTask in config.json). Start with --chat to keep going.", width, INDENT, INDENT, DIM));
  }
  return lines;
}

const INTRO_COMMANDS = [
  ["status", "show current session configuration"],
  ["approvals", "choose what rosetta is allowed to do"],
  ["model", "choose what model to use"],
  ["diff", "show git diff (including untracked files)"],
];

export function userCell(display, width) {
  const rows = sanitize(display).split("\n");
  const shown = rows.length > MAX_USER_LINES ? [...rows.slice(0, MAX_USER_LINES), `… +${rows.length - MAX_USER_LINES} lines`] : rows;
  return shown.flatMap((row, index) => wrapSpans([span(row)], width, [span(index === 0 ? "› " : "  ", style("bold", "cyan"))], INDENT));
}

export function queuedLine(display, width) {
  return truncateSpans([span("↳ ", DIM), span(firstLine(display), style("dim", "italic"))], width);
}

function bullet(styleCode) {
  return span(BULLET, styleCode);
}

function commandLines(command, verb, bulletStyle, width) {
  const rows = sanitize(command).trim().split("\n");
  const pipe = [span("  │ ", DIM)];
  const lines = wrapSpans([span(`${verb} `, BOLD), span(rows[0])], width, [bullet(bulletStyle)], pipe);
  for (const row of rows.slice(1, MAX_COMMAND_LINES)) lines.push(...wrapSpans([span(row)], width, pipe, pipe));
  if (rows.length > MAX_COMMAND_LINES) lines.push([span(`  │ … +${rows.length - MAX_COMMAND_LINES} lines`, DIM)]);
  return lines;
}

function outputLines(text, width, styleCode = DIM) {
  let rows = sanitize(text).trimEnd().split("\n");
  if (rows.length > MAX_OUTPUT_LINES) rows = [...rows.slice(0, 2), `… +${rows.length - 4} lines`, ...rows.slice(-2)];
  return rows.map((row, index) => truncateSpans([span(index === 0 ? "  └ " : "    ", DIM), span(row, styleCode)], width));
}

export function parseExitCode(output) {
  const matches = [...String(output).matchAll(/^\[exit code (-?\d+)\]$/gm)];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

function cleanCommandOutput(output) {
  const text = sanitize(output)
    .split("\n")
    .filter((line) => !/^\[exit code -?\d+\]$/.test(line) && !/^\[shell cwd: .*\]$/.test(line))
    .join("\n")
    .trimEnd();
  return text || "(no output)";
}

export function execCell({ args, status, output }, width) {
  const exitCode = parseExitCode(output);
  const succeeded = status === "ok" && exitCode === 0;
  const lines = commandLines(args?.command ?? "", "Ran", style("bold", succeeded ? "green" : "red"), width);
  const body = status === "ok" ? cleanCommandOutput(output) : firstLine(output);
  lines.push(...outputLines(body, width, status === "ok" ? DIM : RED));
  return lines;
}

export function runningLines(call, width, bulletStyle) {
  if (call.name === "bash") return commandLines(call.args?.command ?? "", "Running", bulletStyle, width);
  const verb = FILE_VERBS[call.name] ?? "Running";
  const target = call.args?.path ? displayPath(call.args.path) : call.name;
  return wrapSpans([span(`${verb} `, BOLD), span(target)], width, [bullet(bulletStyle)], INDENT);
}

export function runningCheckLines(command, width, bulletStyle) {
  return wrapSpans([span("Running tests ", BOLD), span(command)], width, [bullet(bulletStyle)], INDENT);
}

export function checkCell({ command, passed }, width) {
  const lines = wrapSpans([span("Ran tests ", BOLD), span(command)], width, [bullet(style("bold", passed ? "green" : "red"))], INDENT);
  lines.push([span("  └ ", DIM), span(passed ? "passed" : "failed", passed ? GREEN : RED)]);
  return lines;
}

function exploreLabel({ call, status, output }) {
  const args = call.args ?? {};
  const error = status !== "ok" && status !== "running" ? firstLine(output).slice(0, 80) : null;
  if (call.name === "read_file") return { verb: "Read", text: displayPath(args.path), error };
  if (call.name === "list_files") return { verb: "List", text: displayPath(args.path ?? "."), error };
  const where = args.path ? ` in ${displayPath(args.path)}` : "";
  return { verb: "Search", text: `${args.pattern ?? ""}${where}`, error };
}

function groupExploreLabels(entries) {
  const rows = [];
  for (const label of entries.map(exploreLabel)) {
    const last = rows.at(-1);
    if (label.verb === "Read" && !label.error && last?.verb === "Read" && !last.error) last.text += `, ${label.text}`;
    else rows.push({ ...label });
  }
  return rows;
}

export function exploreLines(entries, done, width, bulletStyle = DIM) {
  const lines = [[bullet(bulletStyle), span(done ? "Explored" : "Exploring", BOLD)]];
  groupExploreLabels(entries).forEach((row, index) => {
    const spans = [span(`${row.verb} `, CYAN), span(row.text)];
    if (row.error) spans.push(span(` (${row.error})`, RED));
    lines.push(...wrapSpans(spans, width, [span(index === 0 ? "  └ " : "    ", DIM)], [span("    ")]));
  });
  return lines;
}

export function fileChangeCell({ name, args, status, output }, before, after, width) {
  const file = displayPath(args?.path ?? "");
  if (status !== "ok") {
    const lines = wrapSpans([span(`${FAILED_VERBS[name] ?? "Change"} failed `, BOLD), span(file)], width, [bullet(style("bold", "red"))], INDENT);
    return [...lines, ...outputLines(firstLine(output), width, RED)];
  }
  if (before?.tooLarge || after?.tooLarge) {
    return [[bullet(BOLD), span(`${before === null ? "Added" : "Edited"} `, BOLD), span(file)], [span("  └ (file too large to show a diff)", DIM)]];
  }
  const ops = diffLines(typeof before === "string" ? before : "", typeof after === "string" ? after : "");
  const { added, removed } = countChanges(ops);
  if (name === "delete_file") return wrapSpans([span("Deleted ", BOLD), span(file), span(` (-${removed})`, RED)], width, [bullet(BOLD)], INDENT);
  const counts = [span(" ("), span(`+${added}`, GREEN), span(" "), span(`-${removed}`, RED), span(")")];
  const title = wrapSpans([span(`${before === null ? "Added" : "Edited"} `, BOLD), span(file), ...counts], width, [bullet(BOLD)], INDENT);
  return [...title, ...renderDiffHunks(ops, width, DIFF_INDENT)];
}

export function blockedCell({ name, summary, output }, width) {
  const reason = sanitize(output).replace(/^Blocked by policy: /, "").replace(/\. Choose another way\.$/, "");
  const lines = wrapSpans([span("Blocked ", BOLD), span(`${name} `, YELLOW), span(summary ?? "")], width, [bullet(style("bold", "yellow"))], INDENT);
  return [...lines, ...wrapSpans([span(reason, YELLOW)], width, [span("  └ ", DIM)], [span("    ")])];
}

export function genericToolCell({ name, summary, status, output }, width) {
  const lines = wrapSpans([span(`${name} `, BOLD), span(summary ?? "")], width, [bullet(style("bold", status === "ok" ? "green" : "red"))], INDENT);
  return [...lines, ...outputLines(output, width, status === "ok" ? DIM : RED)];
}

export function noticeCell(text, kind, width) {
  const clean = sanitize(text).trim();
  if (kind === "error") return wrapPlain(clean, width, [span("■ ", RED)], INDENT, RED);
  if (kind === "plain") return wrapPlain(clean, width, INDENT, INDENT);
  if (clean.startsWith("[retry] ")) return wrapPlain(clean.slice(8), width, [span("⚠ ", YELLOW)], INDENT, YELLOW);
  const inner = clean.match(/^\[(.*)\]$/s)?.[1] ?? clean;
  return wrapPlain(inner.charAt(0).toUpperCase() + inner.slice(1), width, [span(BULLET, DIM)], INDENT, DIM);
}

export function interruptedCell(width) {
  return wrapPlain("Conversation interrupted - tell the model what to do differently.", width, [span("■ ", RED)], INDENT, RED);
}

export function reasoningLines(text, width) {
  const body = sanitize(text).trim().split("\n").flatMap((line) => wrapSpans(parseInline(line, style("dim", "italic")), width, INDENT, INDENT));
  return [[span(BULLET, DIM), span("Thinking", style("dim", "bold"))], ...body];
}

export function turnSummaryLine({ seconds, cost, inputTokens, cachedTokens, outputTokens }, width) {
  const parts = [`Worked for ${formatElapsed(seconds)}`, `$${cost.toFixed(4)}`, `${formatTokens(inputTokens)} in`];
  if (cachedTokens > 0) parts.push(`${cachePercent(cachedTokens, inputTokens)}% cached`);
  parts.push(`${formatTokens(outputTokens)} out`);
  const text = `─ ${parts.join(" · ")} `;
  return [span(text + "─".repeat(Math.max(0, width - textWidth(text))), DIM)];
}

function labeledRows(entries, labelWidth) {
  return entries.map((entry) => {
    if (!entry) return [];
    const [label, value, note] = entry;
    const row = [span(`${`${label}:`.padEnd(labelWidth)}`, DIM), span(value)];
    if (note) row.push(span(`  ${note}`, DIM));
    return row;
  });
}

export function statusCell(info, width) {
  const { totals } = info;
  const cache = totals.cachedTokens > 0 ? ` (${formatTokens(totals.cachedTokens)} cached, ${cachePercent(totals.cachedTokens, totals.inputTokens)}%)` : "";
  const contextLeft = Math.max(0, Math.round(100 - (info.contextUsed / info.maxContextTokens) * 100));
  const rows = [
    [span(">_ ", DIM), span("Rosetta", BOLD), span(` (v${info.version})`, DIM)],
    [],
    ...labeledRows([
      ["Model", info.model],
      ["Endpoint", info.baseUrl],
      ...(info.overrides.length > 0 ? [["Overrides", info.overrides.join(", ")]] : []),
      ["Directory", info.directory],
      ["Policy", info.policy, info.policy === "off" ? "no checks" : "blocks writes outside the project and /tmp, git push, secrets"],
      ["Test check", info.check],
      ["Limits", info.limits],
      ["Trace", info.trace],
      null,
      ["Session cost", `$${totals.cost.toFixed(4)}`],
      ["Calls", `${totals.modelCalls} model · ${totals.toolCalls} tool${totals.blockedCalls ? ` (${totals.blockedCalls} blocked)` : ""}`],
      ["Token usage", `${formatTokens(totals.inputTokens)} in${cache} + ${formatTokens(totals.outputTokens)} out`],
      ["Context window", `${contextLeft}% left (${formatTokens(info.contextUsed)} used / ${formatTokens(info.maxContextTokens)})`],
    ], 16),
  ];
  return boxLines(rows, width);
}

export function costCell(totals, traceFile, width) {
  const cache = cachePercent(totals.cachedTokens, totals.inputTokens);
  return [
    [bullet(DIM), span("Session cost ", BOLD), span(`$${totals.cost.toFixed(4)}`)],
    [span("  └ ", DIM), span(`${totals.modelCalls} model calls · ${totals.toolCalls} tool calls`, DIM)],
    [span("    ", DIM), span(`in ${totals.inputTokens} · cached ${totals.cachedTokens} (${cache}%) · out ${totals.outputTokens}`, DIM)],
    truncateSpans([span("    "), span(`trace: ${traceFile ? tildify(traceFile) : "(nothing recorded yet)"}`, DIM)], width),
  ];
}

export function helpCell(commands, width) {
  const nameWidth = Math.max(...commands.map((command) => command.name.length)) + 3;
  const lines = [[bullet(DIM), span("Commands", BOLD)]];
  for (const command of commands.filter((item) => !item.hidden)) {
    lines.push(truncateSpans([span(`  /${command.name}`.padEnd(nameWidth + 2)), span(command.description, DIM)], width));
  }
  lines.push([], [bullet(DIM), span("Keys", BOLD)]);
  for (const [keys, description] of KEY_HELP) lines.push(truncateSpans([span(`  ${keys}`.padEnd(nameWidth + 2)), span(description, DIM)], width));
  return lines;
}

const KEY_HELP = [
  ["⏎", "send the message (queued while a task runs)"],
  ["⇧⏎ / ⌃J", "insert a newline"],
  ["esc", "interrupt the running task, or close a popup"],
  ["⌃C", "interrupt, clear the input, or quit (press twice)"],
  ["⌃D", "quit when the input is empty"],
  ["↑ / ↓", "move through earlier messages"],
  ["⌃T", "open the full transcript (including reasoning)"],
  ["⌃L", "clear the screen"],
  ["@", "search files to mention"],
  ["/", "open the command list"],
];
