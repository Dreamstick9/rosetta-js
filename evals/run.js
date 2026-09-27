import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./lib/args.js";
import { loadTasks } from "./lib/tasks.js";
import { parseSettings } from "./lib/settings.js";
import { ensureClones } from "./lib/workspace.js";
import { runPool } from "./lib/pool.js";
import { runJob } from "./lib/job.js";
import { renderAb, renderRuns, totals } from "./lib/report.js";
import { sh } from "./lib/shell.js";

const RESULTS_DIR = new URL("./results/", import.meta.url).pathname;
const DEFAULT_HARNESS = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.oracle && !process.env.AI_API_KEY) fail("AI_API_KEY is not set. Export it first.");
  const tasks = loadTasks(options);
  const arms = buildArms(options);
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const context = buildContext(options, stamp);
  console.log(`Eval ${stamp}: ${tasks.length} tasks × ${options.runs} runs × ${arms.length} arms, parallel ${options.parallel}`);
  await ensureClones(tasks);
  const jobs = buildJobs(tasks, arms, options.runs);
  const records = await runPool(jobs, options.parallel, (job) => runJob(job, context).then((record) => saveRecord(context, record)));
  await writeResults({ stamp, options, arms, context, records });
}

function buildArms(options) {
  if (!options.ab) return [{ name: "run", label: options.env.join(" ") || "defaults", settings: parseSettings(options.env) }];
  return options.ab.map((text, index) => ({
    name: index === 0 ? "A" : "B",
    label: text,
    settings: parseSettings([...options.env, text]),
  }));
}

function buildContext(options, stamp) {
  return {
    harnessSource: path.resolve(options.harness ?? DEFAULT_HARNESS),
    workRoot: path.join(os.tmpdir(), "rjs-eval", stamp),
    logRoot: path.join(RESULTS_DIR, stamp),
    oracle: options.oracle,
    timeout: options.timeout,
    keep: options.keep,
  };
}

function buildJobs(tasks, arms, runs) {
  const jobs = [];
  for (const task of tasks) {
    for (let run = 1; run <= runs; run++) for (const arm of arms) jobs.push({ task, arm, run });
  }
  return jobs;
}

function saveRecord(context, record) {
  fs.appendFileSync(path.join(context.logRoot, "records.jsonl"), `${JSON.stringify(record)}\n`);
  return printProgress(record);
}

function printProgress(record) {
  const status = record.passed ? "PASS" : "FAIL";
  const cost = record.cost === undefined ? "" : ` $${record.cost.toFixed(4)}`;
  const seconds = record.seconds === undefined ? "" : ` ${record.seconds.toFixed(0)}s`;
  const detail = record.error ? ` error: ${record.error.split("\n")[0]}` : ` ${record.outcome ?? ""}`;
  console.log(`${status} ${record.task} [${record.arm}#${record.run}]${cost}${seconds}${detail}`);
  return record;
}

async function writeResults({ stamp, options, arms, context, records }) {
  const commit = (await sh("git rev-parse --short HEAD", { cwd: context.harnessSource })).output.trim();
  const title = `# Eval ${stamp}\n\nHarness: ${context.harnessSource} @ ${commit}${context.oracle ? ` · oracle ${context.oracle}` : ""}\nLogs: ${context.logRoot}\n`;
  const sections = [title, renderRuns(records)];
  if (options.ab) sections.push(`\n## A/B\n\n${renderAb(records, arms)}`);
  const markdown = `${sections.join("\n")}\n`;
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `${stamp}.md`), markdown);
  const json = { stamp, harness: context.harnessSource, commit, options, arms, totals: totals(records), records };
  fs.writeFileSync(path.join(RESULTS_DIR, `${stamp}.json`), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`\n${markdown}\nWrote evals/results/${stamp}.md and .json`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main().catch((error) => fail(error.stack ?? String(error)));
