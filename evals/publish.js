import fs from "node:fs";
import path from "node:path";

const RESULTS_DIR = new URL("./results/", import.meta.url).pathname;
const TASKS_DIR = new URL("./tasks/", import.meta.url).pathname;
const README = new URL("../README.md", import.meta.url).pathname;
const START = "<!-- EVAL:START -->";
const END = "<!-- EVAL:END -->";
const BAR_WIDTH = 12;
const CATEGORY_LABELS = { issue: "Real GitHub issue", debug: "Debugging", multistep: "Multi-step feature", refactor: "Refactor", impossible: "Impossible task" };
const OUTCOME_LABELS = { done: "done", stalled: "stalled", timeout: "timed out", max_turns: "turn limit", budget: "budget", give_up: "gave up" };

function readAllRecords() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  const runs = fs.readdirSync(RESULTS_DIR).filter((name) => fs.existsSync(path.join(RESULTS_DIR, name, "records.jsonl"))).sort();
  const latest = new Map();
  for (const run of runs) {
    for (const record of readRecords(path.join(RESULTS_DIR, run, "records.jsonl"))) {
      if (record.arm === "run" || !record.arm) latest.set(record.task, { ...record, runStamp: run });
    }
  }
  return [...latest.values()];
}

function readRecords(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

function readTask(id) {
  const file = path.join(TASKS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function repoName(task) {
  if (!task.repo) return "";
  return task.repo.replace("https://github.com/", "");
}

function formatMoney(value) {
  return `$${value.toFixed(4)}`;
}

function formatSeconds(value) {
  if (value >= 60) return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  return `${value.toFixed(0)}s`;
}

function cacheShare(record) {
  if (!record.inputTokens) return 0;
  return Math.round((record.cachedTokens / record.inputTokens) * 100);
}

function drawBar(value, max) {
  const filled = max > 0 ? Math.max(1, Math.round((value / max) * BAR_WIDTH)) : 0;
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

function badge(label, message, color) {
  const text = (value) => encodeURIComponent(value.replaceAll("-", "--").replaceAll("_", "__"));
  return `![${label}](https://img.shields.io/badge/${text(label)}-${text(message)}-${color}?style=for-the-badge)`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(records) {
  const passed = records.filter((record) => record.passed).length;
  const costs = records.map((record) => record.cost ?? 0);
  const seconds = records.map((record) => record.seconds ?? 0);
  const input = records.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0);
  const cached = records.reduce((sum, record) => sum + (record.cachedTokens ?? 0), 0);
  return {
    passed,
    total: records.length,
    totalCost: costs.reduce((sum, value) => sum + value, 0),
    medianCost: median(costs),
    medianSeconds: median(seconds),
    cacheShare: input > 0 ? Math.round((cached / input) * 100) : 0,
  };
}

function renderBadges(summary) {
  const passColor = summary.passed / summary.total >= 0.7 ? "2ea44f" : "d29922";
  return [
    badge("tasks solved", `${summary.passed}/${summary.total}`, passColor),
    badge("median cost", formatMoney(summary.medianCost), "0969da"),
    badge("median time", formatSeconds(summary.medianSeconds), "8250df"),
    badge("prompt cache", `${summary.cacheShare}%`, "1f6feb"),
  ].join(" ");
}

function renderRow(record, maxCost) {
  const task = readTask(record.task);
  const status = record.passed ? "✅" : "❌";
  const source = repoName(task) ? `<sub>${repoName(task)}</sub>` : "";
  const category = CATEGORY_LABELS[record.category] ?? record.category;
  const outcome = OUTCOME_LABELS[record.outcome] ?? record.outcome ?? "";
  const cost = `\`${drawBar(record.cost ?? 0, maxCost)}\` ${formatMoney(record.cost ?? 0)}`;
  const agents = record.subAgents ? ` · ${record.subAgents} sub-agents` : "";
  const detail = `${record.modelCalls ?? 0} calls · ${cacheShare(record)}% cached${agents}`;
  return `| ${status} | **${record.task}**<br>${source} | ${category} | ${cost} | ${formatSeconds(record.seconds ?? 0)} | ${outcome} | ${detail} |`;
}

function renderSection(records) {
  const summary = summarize(records);
  const maxCost = Math.max(...records.map((record) => record.cost ?? 0));
  const ordered = [...records].sort((a, b) => Number(b.passed) - Number(a.passed) || (a.cost ?? 0) - (b.cost ?? 0));
  const newest = records.map((record) => record.runStamp).sort().at(-1);
  const lines = [
    START,
    "",
    renderBadges(summary),
    "",
    `**${summary.passed} of ${summary.total} hard tasks solved** for **${formatMoney(summary.totalCost)} in total** — graded by hidden tests the agent never sees.`,
    "",
    "| | Task | Type | Cost | Time | Outcome | Model use |",
    "|:-:|---|---|---|--:|---|---|",
    ...ordered.map((record) => renderRow(record, maxCost)),
    "",
    `<sub>Model: deepseek/deepseek-v4.1-flash · one run per task · latest run ${newest} · regenerate with \`make eval\` (updates this table automatically) or \`node evals/publish.js\`.</sub>`,
    "",
    END,
  ];
  return lines.join("\n");
}

function updateReadme(section) {
  const readme = fs.readFileSync(README, "utf8");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1) {
    console.error(`README.md has no ${START} … ${END} block; nothing updated.`);
    process.exit(1);
  }
  const next = `${readme.slice(0, start)}${section}${readme.slice(end + END.length)}`;
  fs.writeFileSync(README, next);
}

export function publishResults() {
  const records = readAllRecords();
  if (records.length === 0) return console.log("No eval records found; README unchanged.");
  updateReadme(renderSection(records));
  console.log(`README.md eval table updated with ${records.length} tasks.`);
}

if (import.meta.url === `file://${process.argv[1]}`) publishResults();
