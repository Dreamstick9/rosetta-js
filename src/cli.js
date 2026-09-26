#!/usr/bin/env node
import { CONFIG } from "./config.js";
import { Agent } from "./agent.js";
import { Trace } from "./trace.js";
import { countChangedFiles, takeProjectSnapshot } from "./checks.js";
import { stopShell } from "./tools/shell.js";
import { readHeadlessTask, readUserMessage, startTerminalInput, stopTerminalInput, watchForInterrupt } from "./input.js";
import { writeDimLine, writeError, writeFooter } from "./ui.js";
import { handleCommand, isCommand } from "./slash.js";
import { openWorkingFolder } from "./workdir.js";
import { runIntake } from "./intake/index.js";
import { parseTaskReference } from "./intake/parse.js";

const EXIT_CODES = { done: 0, max_turns: 3, budget: 3 };
const SESSION_STARTED_AT = Date.now();

let sessionSnapshot = null;
let firstTaskStarted = false;
let lastStatus = "no_task";

async function main() {
  const config = CONFIG;
  if (!config.apiKey) exitWithError("AI_API_KEY is not set. Export it in your environment first.");
  process.on("exit", cleanUp);
  writeDimLine(describeModel(config));
  const args = process.argv.slice(2);
  const resuming = args.includes("--resume");
  const task = resuming ? null : await readHeadlessTask(args);
  const problem = openWorkingFolder(task === null || parseTaskReference(task) !== null);
  if (problem) exitWithError(problem);
  const trace = new Trace(config);
  if (resuming) return runHeadlessResume(config, trace);
  if (task !== null) return runHeadless(config, trace, task);
  return runInteractive(config, trace, args.includes("--chat") || !config.exitAfterTask);
}

function describeModel(config) {
  const overrides = config.overrides.length > 0 ? ` (overridden by ${config.overrides.join(", ")})` : "";
  return `Model: ${config.model} at ${config.baseUrl}${overrides} · policy ${config.policy}`;
}

async function runHeadless(config, trace, task) {
  if (!task.trim()) exitWithError('Usage: node src/cli.js -p "task"   (or pipe the task on stdin, or set ISSUE)');
  const agent = new Agent({ config, trace });
  await runTask(trace, new AbortController().signal, (signal) => startTask(agent, trace, task, signal));
  finishSession(trace);
}

async function runHeadlessResume(config, trace) {
  const agent = new Agent({ config, trace });
  await runTask(trace, new AbortController().signal, (signal) => resumeTask(agent, signal));
  finishSession(trace);
}

async function runInteractive(config, trace, keepChatting) {
  const agent = new Agent({ config, trace });
  startTerminalInput();
  writeDimLine(keepChatting ? "Type /help for commands." : "Type or paste the task and press Enter. /help lists commands.");
  while (true) {
    const input = await readUserMessage();
    if (input === null || input.trim() === "/exit") break;
    const text = input.trim();
    if (!text) continue;
    if (isCommand(text) && text !== "/resume") {
      handleCommand(agent, trace, text);
      continue;
    }
    const start = text === "/resume" ? (signal) => resumeTask(agent, signal) : (signal) => startTask(agent, trace, input, signal);
    await runInteractiveTask(trace, start);
    if (!keepChatting) break;
  }
  finishSession(trace);
}

async function runInteractiveTask(trace, start) {
  const controller = new AbortController();
  const stopWatching = watchForInterrupt(() => controller.abort());
  await runTask(trace, controller.signal, start);
  stopWatching();
}

async function startTask(agent, trace, text, signal) {
  const task = await prepareFirstTask(trace, text, signal);
  return agent.runTask(task, signal);
}

async function resumeTask(agent, signal) {
  markFirstTask();
  return agent.resumeTask(signal);
}

async function runTask(trace, signal, start) {
  const startedAt = Date.now();
  try {
    const stats = await start(signal);
    const result = { ...stats, seconds: (Date.now() - startedAt) / 1000 };
    writeFooter(result);
    trace.recordTaskEnd(result);
    if (result.outcome !== "done") writeError(`Outcome: ${result.outcome}`);
    lastStatus = result.outcome;
  } catch (error) {
    if (signal.aborted) writeDimLine("[interrupted]");
    else writeError(`Error: ${error.message}`);
    lastStatus = signal.aborted ? "interrupted" : "error";
  }
}

async function prepareFirstTask(trace, text, signal) {
  if (firstTaskStarted) return text;
  const task = await runIntake(text, trace, signal);
  markFirstTask();
  return task;
}

function markFirstTask() {
  if (firstTaskStarted) return;
  firstTaskStarted = true;
  sessionSnapshot = takeProjectSnapshot();
}

function finishSession(trace) {
  const summary = {
    status: lastStatus,
    cost: Number(trace.totals.cost.toFixed(6)),
    seconds: Number(((Date.now() - SESSION_STARTED_AT) / 1000).toFixed(1)),
    filesChanged: countChangedFiles(sessionSnapshot, sessionSnapshot && takeProjectSnapshot()),
  };
  process.stderr.write(`${JSON.stringify(summary)}\n`);
  process.exit(EXIT_CODES[lastStatus] ?? (lastStatus === "no_task" ? 0 : 1));
}

function cleanUp() {
  stopShell();
  stopTerminalInput();
}

function exitWithError(message) {
  writeError(message);
  process.exit(1);
}

main();
