const NOISE_NOTE = "Note: DeepSeek run-to-run noise is about ±30% per task on $ and seconds; trust totals over single tasks and use --runs 2+ before concluding.";
const TOP_TOOLS = 4;

export function renderRuns(records) {
  const header = "| task | category | pass | $ | sec | in | cached | out | calls | tools | top tools | outcome | attempts | skills | subagents | blocked |";
  const divider = `|${"---|".repeat(16)}`;
  const rows = records.map(runRow);
  return [header, divider, ...rows, totalsRow(records)].join("\n");
}

function runRow(r) {
  const label = r.run > 1 || r.arm !== "run" ? `${r.task} (${r.arm}#${r.run})` : r.task;
  const outcome = r.error ? `error: ${r.error.split("\n")[0].slice(0, 60)}` : r.outcome ?? "-";
  return cells([label, r.category, mark(r.passed), money(r.cost), secs(r.seconds), r.inputTokens, r.cachedTokens, r.outputTokens, r.modelCalls, r.toolCalls, topTools(r.toolsByName), outcome, r.attempts, (r.skills ?? []).join(" ") || "-", r.subAgents, r.blocked]);
}

function totalsRow(records) {
  const total = totals(records);
  return cells(["**total**", "", `${total.passed}/${total.count}`, money(total.cost), secs(total.seconds), total.inputTokens, total.cachedTokens, total.outputTokens, total.modelCalls, total.toolCalls, "", "", total.attempts, "", total.subAgents, total.blocked]);
}

export function totals(records) {
  const fields = ["cost", "seconds", "inputTokens", "cachedTokens", "outputTokens", "modelCalls", "toolCalls", "attempts", "subAgents", "blocked"];
  const total = { count: records.length, passed: records.filter((r) => r.passed).length };
  for (const field of fields) total[field] = records.reduce((sum, r) => sum + (Number(r[field]) || 0), 0);
  return total;
}

export function renderAb(records, arms) {
  const [a, b] = arms.map((arm) => arm.name);
  const header = `| task | pass ${a} | pass ${b} | $ ${a} | $ ${b} | Δ$ | sec ${a} | sec ${b} | Δsec |`;
  const divider = `|${"---|".repeat(9)}`;
  const tasks = [...new Set(records.map((r) => r.task))];
  const rows = tasks.map((task) => abRow(task, records.filter((r) => r.task === task), a, b));
  const all = abRow("**total**", records, a, b, true);
  return [`A = ${arms[0].label}`, `B = ${arms[1].label}`, "", header, divider, ...rows, all, "", NOISE_NOTE].join("\n");
}

function abRow(label, records, a, b, summed = false) {
  const left = armStats(records.filter((r) => r.arm === a), summed);
  const right = armStats(records.filter((r) => r.arm === b), summed);
  return cells([label, left.pass, right.pass, money(left.cost), money(right.cost), delta(left.cost, right.cost, money), secs(left.seconds), secs(right.seconds), delta(left.seconds, right.seconds, secs)]);
}

function armStats(records, summed) {
  const total = totals(records);
  const divisor = summed ? 1 : Math.max(total.count, 1);
  return { pass: `${total.passed}/${total.count}`, cost: total.cost / divisor, seconds: total.seconds / divisor };
}

function delta(before, after, format) {
  const change = after - before;
  const percent = before ? ` (${change >= 0 ? "+" : ""}${Math.round((change / before) * 100)}%)` : "";
  return `${change >= 0 ? "+" : "-"}${format(Math.abs(change))}${percent}`;
}

function topTools(counts = {}) {
  return Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, TOP_TOOLS).map(([name, count]) => `${name} ${count}`).join(", ") || "-";
}

function cells(values) {
  return `| ${values.map((value) => String(value ?? "-").replaceAll("|", "\\|")).join(" | ")} |`;
}

function mark(passed) {
  return passed ? "✅" : "❌";
}

function money(value) {
  return value === undefined ? "-" : `$${Number(value).toFixed(4)}`;
}

function secs(value) {
  return value === undefined ? "-" : `${Number(value).toFixed(0)}s`;
}
