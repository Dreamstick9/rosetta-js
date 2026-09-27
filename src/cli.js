#!/usr/bin/env node
import { CONFIG } from "./config.js";
import { Trace } from "./trace.js";
import { countChangedFiles, takeProjectSnapshot } from "./checks.js";
import { prepareModel } from "./model/prepare.js";
import { stopShell } from "./tools/shell.js";
import { readBestOfSize, readHeadlessTask, readUserMessage, startTerminalInput, stopTerminalInput, watchForInterrupt } from "./input.js";
import { setUiSink, writeDimLine, writeError, writeFooter, writeInterrupted } from "./ui.js";
import { handleCommand, isCommand, parseBestOf } from "./slash.js";
import { Tui } from "./tui/app.js";
import { openWorkingFolder } from "./workdir.js";
import { parseTaskReference } from "./intake/parse.js";
import { chooseTaskStart, createMainAgent, readSessionSnapshot, resumeTask, startBestOf, startTask } from "./taskstart.js";

const EXIT_CODES = { done: 0, max_turns: 3, budget: 3 };
const SESSION_STARTED_AT = Date.now();

let lastStatus = "no_task";

async function main() {
  const config = CONFIG;
  if (!config.apiKey) exitWithError("AI_API_KEY is not set. Export it in your environment first.");
  process.on("exit", cleanUp);
  const args = process.argv.slice(2);
  const resuming = args.includes("--resume");
  const task = resuming ? null : await readHeadlessTask(args);
  const tui = !resuming && task === null && wantsTui(args) ? new Tui() : null;
  if (!tui) writeDimLine(describeModel(config));
  await prepareModel(config);
  const problem = openWorkingFolder(task === null || parseTaskReference(task) !== null);
  if (problem) exitWithError(problem);
  const trace = new Trace(config);
  if (resuming) return runHeadlessResume(config, trace);
  if (task !== null) return runHeadless(config, trace, task, readBestOfSize(args));
  const keepChatting = args.includes("--chat") || !config.exitAfterTask;
  if (tui) return runTui(tui, config, trace, keepChatting);
  return runInteractive(config, trace, keepChatting);
}

function wantsTui(args) {
  if (args.includes("--plain") || process.env.ROSETTA_UI === "line") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function describeModel(config) {
  const overrides = config.overrides.length > 0 ? ` (overridden by ${config.overrides.join(", ")})` : "";
  return `Model: ${config.model} at ${config.baseUrl}${overrides} · policy ${config.policy}`;
}

async function runHeadless(config, trace, task, bestOfSize) {
  if (!task.trim()) exitWithError('Usage: node src/cli.js -p "task" [--best-of N]   (or pipe the task on stdin, or set ISSUE)');
  if (bestOfSize === undefined) exitWithError("--best-of needs a whole number of workers, 1 or more.");
  const agent = createMainAgent(config, trace);
  const start = bestOfSize ? (signal) => startBestOf(agent, trace, { size: bestOfSize, task }, signal) : (signal) => startTask(agent, trace, task, signal);
  await runTask(trace, new AbortController().signal, start);
  finishSession(trace);
}

async function runHeadlessResume(config, trace) {
  const agent = createMainAgent(config, trace);
  await runTask(trace, new AbortController().signal, (signal) => resumeTask(agent, signal));
  finishSession(trace);
}

async function runTui(tui, config, trace, keepChatting) {
  const agent = createMainAgent(config, trace);
  const runTuiTask = (text, signal) => runTask(trace, signal, chooseTaskStart(agent, trace, text));
  await tui.run({ agent, trace, keepChatting, runTask: runTuiTask });
  finishSession(trace);
}

async function runInteractive(config, trace, keepChatting) {
  const agent = createMainAgent(config, trace);
  startTerminalInput();
  writeDimLine(keepChatting ? "Type /help for commands." : "Type or paste the task and press Enter. /help lists commands.");
  while (true) {
    const input = await readUserMessage();
    if (input === null || input.trim() === "/exit") break;
    const text = input.trim();
    if (!text) continue;
    if (isCommand(text) && text !== "/resume" && !parseBestOf(text)) {
      handleCommand(agent, trace, text);
      continue;
    }
    await runInteractiveTask(trace, chooseTaskStart(agent, trace, input));
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
    if (signal.aborted) writeInterrupted();
    else writeError(`Error: ${error.message}`);
    lastStatus = signal.aborted ? "interrupted" : "error";
  }
}

function finishSession(trace) {
  const sessionSnapshot = readSessionSnapshot();
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
  setUiSink(null);
  writeError(message);
  process.exit(1);
}

main();
