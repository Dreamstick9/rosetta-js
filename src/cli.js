#!/usr/bin/env node
import { CONFIG } from "./config.js";
import { Agent } from "./agent.js";
import { Trace } from "./trace.js";
import { countChangedFiles, takeProjectSnapshot } from "./checks.js";
import { prepareModel } from "./model/prepare.js";
import { stopShell } from "./tools/shell.js";
import { readHeadlessTask, readUserMessage, startTerminalInput, stopTerminalInput, watchForInterrupt } from "./input.js";
import { writeCostSummary, writeDimLine, writeError, writeFooter, writeLine } from "./ui.js";
import { openWorkingFolder } from "./workdir.js";
import { runIntake } from "./intake/index.js";
import { parseTaskReference } from "./intake/parse.js";

const HELP = `Commands:
  /help         show this help
  /new          clear the conversation
  /cost         show the session cost and token totals
  /check off    stop running the tests after changes (/check on turns it back on)
  /exit         quit
Esc or Ctrl-C stops the current turn. Ctrl-C at the prompt quits.`;
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
  await prepareModel(config);
  const args = process.argv.slice(2);
  const task = await readHeadlessTask(args);
  const problem = openWorkingFolder(task === null || parseTaskReference(task) !== null);
  if (problem) exitWithError(problem);
  const trace = new Trace(config);
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
  await runTask(agent, trace, task, new AbortController().signal);
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
    if (isCommand(text)) {
      handleCommand(agent, trace, text);
      continue;
    }
    if (!text) continue;
    await runInteractiveTask(agent, trace, input);
    if (!keepChatting) break;
  }
  finishSession(trace);
}

function isCommand(text) {
  return text.startsWith("/") && !text.includes("\n");
}

async function runInteractiveTask(agent, trace, text) {
  const controller = new AbortController();
  const stopWatching = watchForInterrupt(() => controller.abort());
  await runTask(agent, trace, text, controller.signal);
  stopWatching();
}

async function runTask(agent, trace, text, signal) {
  const startedAt = Date.now();
  try {
    const task = await prepareFirstTask(trace, text, signal);
    const stats = await agent.runTask(task, signal);
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
  firstTaskStarted = true;
  const task = await runIntake(text, trace, signal);
  sessionSnapshot = takeProjectSnapshot();
  return task;
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

function handleCommand(agent, trace, command) {
  if (command === "/help") return writeLine(HELP);
  if (command === "/cost") return writeCostSummary(trace.totals, trace.file);
  if (command === "/new") {
    agent.reset();
    return writeDimLine("Conversation cleared.");
  }
  if (command === "/check on" || command === "/check off") {
    agent.doneCheckEnabled = command === "/check on";
    return writeDimLine(`Test check after changes is ${agent.doneCheckEnabled ? "on" : "off"}.`);
  }
  writeLine(`Unknown command ${command}.\n${HELP}`);
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
