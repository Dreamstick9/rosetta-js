import { WEB } from "./settings.js";

const OUTLINE_DEPTH = 3;
const OUTLINE_KEYS = 30;
const OUTLINE_SHARE = 0.4;
const SCALAR_PREVIEW = 60;
const MATCH_PREVIEW = 400;
const STOP_WORDS = new Set(["the", "and", "for", "with", "what", "which", "from", "that", "this", "are", "how", "does", "all", "its", "into", "about", "value", "values"]);

export function parseJson(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function digestJson(data, prompt = "") {
  const pretty = JSON.stringify(data, null, 1);
  if (pretty.length <= WEB.jsonDigestBytes) return pretty;
  const outline = capLines(buildOutline(data, 0, ""), WEB.jsonDigestBytes * OUTLINE_SHARE);
  const words = promptWords(prompt);
  const heading = words.length > 0 ? `Values whose keys match: ${words.join(", ")}` : "Values (no prompt given; pass prompt words to pick keys)";
  const values = capLines(listValues(data, words), WEB.jsonDigestBytes - outline.length);
  return [`JSON outline (${pretty.length} chars in full):`, outline, "", `${heading}:`, values || "(none)"].join("\n");
}

function buildOutline(value, depth, indent) {
  if (!value || typeof value !== "object" || depth >= OUTLINE_DEPTH) return [];
  const lines = [];
  const entries = Array.isArray(value) ? value.slice(0, 1).map((item) => ["[0]", item]) : Object.entries(value);
  for (const [key, child] of entries.slice(0, OUTLINE_KEYS)) {
    lines.push(`${indent}${key}: ${describe(child)}`);
    lines.push(...buildOutline(child, depth + 1, `${indent}  `));
  }
  if (entries.length > OUTLINE_KEYS) lines.push(`${indent}… ${entries.length - OUTLINE_KEYS} more keys`);
  return lines;
}

function describe(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return `object(${Object.keys(value).length} keys)`;
  return truncate(JSON.stringify(value), SCALAR_PREVIEW);
}

function truncate(text, length) {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

export function promptWords(prompt) {
  const words = prompt.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}

function listValues(data, words) {
  const rows = new Map();
  for (const { path, value } of walk(data, "", words)) {
    const [, row, key] = /^(.*\])\.?(.*)$/.exec(path) ?? [null, path, ""];
    const text = truncate(JSON.stringify(value), MATCH_PREVIEW);
    if (!rows.has(row)) rows.set(row, { pairs: [], values: "" });
    rows.get(row).pairs.push(key ? `${key}=${text}` : text);
    rows.get(row).values += text.toLowerCase();
  }
  const entries = [...rows].map(([row, { pairs, values }]) => ({ line: `${row}${row.endsWith("]") ? "" : " ="} ${pairs.join(" ")}`, values }));
  const mentioned = entries.filter((entry) => words.some((word) => entry.values.includes(word)));
  return (mentioned.length > 0 ? mentioned : entries).map((entry) => entry.line);
}

function* walk(value, path, words) {
  if (path && (words.length === 0 ? !isContainer(value) : pathMatches(path, words))) {
    yield { path, value };
    return;
  }
  if (!isContainer(value)) return;
  for (const [key, child] of Object.entries(value)) {
    yield* walk(child, Array.isArray(value) ? `${path}[${key}]` : joinPath(path, key), words);
  }
}

function isContainer(value) {
  return Boolean(value) && typeof value === "object";
}

function joinPath(path, key) {
  return path ? `${path}.${key}` : key;
}

function pathMatches(path, words) {
  const lastKey = path.toLowerCase().split(/[.[\]]/).filter(Boolean).at(-1);
  return words.some((word) => lastKey.includes(word));
}

function capLines(lines, maxChars) {
  const kept = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length + 1 > maxChars) {
      kept.push("…");
      break;
    }
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join("\n");
}
