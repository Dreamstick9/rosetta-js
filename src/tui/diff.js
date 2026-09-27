import { sanitize, span, style, truncateSpans, wrapSpans } from "./text.js";

const CONTEXT_LINES = 3;
const MAX_LCS_CELLS = 4_000_000;
const MAX_DIFF_LINES = 400;
const MAX_GIT_DIFF_LINES = 2000;
const SIGN_STYLES = { "+": style("green"), "-": style("red"), " ": "" };

export function diffLines(oldText, newText) {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++;
  const middle = diffMiddle(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix));
  const ops = [];
  let oldNumber = 1;
  let newNumber = 1;
  const push = (type, text) => {
    ops.push({ type, text, oldNumber, newNumber });
    if (type !== "+") oldNumber++;
    if (type !== "-") newNumber++;
  };
  for (let index = 0; index < prefix; index++) push(" ", before[index]);
  for (const op of middle) push(op.type, op.text);
  for (let index = before.length - suffix; index < before.length; index++) push(" ", before[index]);
  return ops;
}

function splitLines(text) {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffMiddle(before, after) {
  const removed = before.map((text) => ({ type: "-", text }));
  const added = after.map((text) => ({ type: "+", text }));
  if (before.length === 0 || after.length === 0 || before.length * after.length > MAX_LCS_CELLS) return [...removed, ...added];
  const columns = after.length + 1;
  const table = new Uint32Array((before.length + 1) * columns);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * columns + j] = before[i] === after[j]
        ? table[(i + 1) * columns + j + 1] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ type: " ", text: before[i++] });
      j++;
    } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) ops.push(removed[i++]);
    else ops.push(added[j++]);
  }
  return [...ops, ...removed.slice(i), ...added.slice(j)];
}

export function countChanges(ops) {
  return {
    added: ops.filter((op) => op.type === "+").length,
    removed: ops.filter((op) => op.type === "-").length,
  };
}

export function renderDiffHunks(ops, width, indent) {
  const ranges = findHunkRanges(ops);
  if (ranges.length === 0) return [[span(`${indent}(no changes)`, style("dim"))]];
  const lastNumber = Math.max(...ops.map((op) => Math.max(op.oldNumber, op.newNumber)));
  const gutter = String(lastNumber).length;
  const lines = [];
  ranges.forEach((range, index) => {
    if (index > 0) lines.push([span(`${indent}${" ".repeat(gutter)} ⋮`, style("dim"))]);
    for (let opIndex = range.start; opIndex <= range.end; opIndex++) lines.push(...renderDiffOp(ops[opIndex], gutter, width, indent));
  });
  return limitLines(lines, MAX_DIFF_LINES, indent);
}

function findHunkRanges(ops) {
  const ranges = [];
  ops.forEach((op, index) => {
    if (op.type === " ") return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  });
  return ranges;
}

function renderDiffOp(op, gutter, width, indent) {
  const number = String(op.type === "-" ? op.oldNumber : op.newNumber).padStart(gutter);
  const signStyle = SIGN_STYLES[op.type];
  const first = [span(indent), span(number, style("dim")), span(` ${op.type}`, signStyle)];
  const rest = [span(`${indent}${" ".repeat(gutter + 2)}`)];
  return wrapSpans([span(sanitize(op.text), signStyle)], width, first, rest);
}

function limitLines(lines, maxLines, indent) {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), [span(`${indent}… +${lines.length - maxLines} lines`, style("dim"))]];
}

export function renderGitDiff(text, width) {
  const lines = sanitize(text).trimEnd().split("\n").map((line) => truncateSpans([span(line, gitLineStyle(line))], width));
  return limitLines(lines, MAX_GIT_DIFF_LINES, "");
}

function gitLineStyle(line) {
  if (line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) return style("bold");
  if (line.startsWith("@@")) return style("cyan");
  if (line.startsWith("+")) return style("green");
  if (line.startsWith("-")) return style("red");
  if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) return style("dim");
  return "";
}
