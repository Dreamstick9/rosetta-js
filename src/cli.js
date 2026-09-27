#!/usr/bin/env node
import fs from "node:fs";
import { CONFIG } from "./config.js";
import { Agent } from "./agent.js";
import { Trace } from "./trace.js";
import { countChangedFiles, takeProjectSnapshot } from "./checks.js";
import { stopShell } from "./tools/shell.js";
import { readPipedInput, readUserMessage, startTerminalInput, stopTerminalInput, watchForInterrupt } from "./input.js";
import { setUiSink, writeCostSummary, writeDimLine, writeError, writeFooter, writeInterrupted, writeLine } from "./ui.js";
import { Tui } from "./tui/app.js";
import { openWorkingFolder } from "./workdir.js";

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
let lastStatus = "no_task";

async function main() {
  const config = CONFIG;
  if (!config.apiKey) exitWithError("AI_API_KEY is not set. Export it in your environment first.");
  process.on("exit", cleanUp);
  const args = process.argv.slice(2);
  const tui = wantsTui(args) ? new Tui() : null;
  if (!tui) writeDimLine(describeModel(config));
  const problem = openWorkingFolder();
  if (problem) exitWithError(problem);
  const trace = new Trace(config);
  const prompt = readPromptArgument(args) ?? readIssueVariable();
  if (prompt !== null) return runHeadless(config, trace, prompt);
  if (!process.stdin.isTTY) return runHeadless(config, trace, await readPipedInput());
  const keepChatting = args.includes("--chat") || !config.exitAfterTask;
  if (tui) return runTui(tui, config, trace, keepChatting);
  return runInteractive(config, trace, keepChatting);
}

function wantsTui(args) {
  const headless = readPromptArgument(args) !== null || Boolean(process.env.ISSUE);
  return !headless && !args.includes("--plain") && process.stdin.isTTY && process.stdout.isTTY;
}

function describeModel(config) {
  const overrides = config.overrides.length > 0 ? ` (overridden by ${config.overrides.join(", ")})` : "";
  return `Model: ${config.model} at ${config.baseUrl}${overrides} · policy ${config.policy}`;
}

function readIssueVariable() {
  const issue = process.env.ISSUE;
  if (!issue) return null;
  if (fs.existsSync(issue) && fs.statSync(issue).isFile()) return fs.readFileSync(issue, "utf8");
  return issue;
}

function readPromptArgument(args) {
  const index = args.findIndex((arg) => arg === "-p" || arg === "--prompt");
  if (index === -1) return null;
  return args[index + 1] ?? "";
}

async function runHeadless(config, trace, task) {
  if (!task.trim()) exitWithError('Usage: node src/cli.js -p "task"   (or pipe the task on stdin, or set ISSUE)');
  const agent = new Agent({ config, trace });
  await runTask(agent, trace, task, new AbortController().signal);
  finishSession(trace);
}

async function runTui(tui, config, trace, keepChatting) {
  const agent = new Agent({ config, trace });
  await tui.run({ agent, trace, keepChatting, runTask: (text, signal) => runTask(agent, trace, text, signal) });
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
  sessionSnapshot ??= takeProjectSnapshot();
  try {
    const stats = await agent.runTask(text, signal);
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
  setUiSink(null);
  writeError(message);
  process.exit(1);
}

main();
