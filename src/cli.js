#!/usr/bin/env node
import fs from "node:fs";
import { CONFIG } from "./config.js";
import { Agent } from "./agent.js";
import { Trace } from "./trace.js";
import { stopShell } from "./tools/shell.js";
import { readPipedInput, readUserMessage, startTerminalInput, stopTerminalInput, watchForInterrupt } from "./input.js";
import { writeCostSummary, writeDimLine, writeError, writeFooter, writeLine } from "./ui.js";
import { chooseWorkingFolder, findPresetFolder, openPresetFolder } from "./workdir.js";

const HELP = `Commands:
  /help         show this help
  /new          clear the conversation
  /cost         show the session cost and token totals
  /check off    stop running the tests after changes (/check on turns it back on)
  /exit         quit
Esc or Ctrl-C stops the current turn. Ctrl-C at the prompt quits.`;

let workingFolderReady = false;

async function main() {
  const config = CONFIG;
  if (!config.apiKey) exitWithError("AI_API_KEY is not set. Export it in your environment first.");
  process.on("exit", cleanUp);
  writeDimLine(describeModel(config));
  openPresetFolderOrExit();
  const trace = new Trace(config);
  const prompt = readPromptArgument(process.argv.slice(2)) ?? readIssueVariable();
  if (prompt !== null) return runHeadless(config, trace, prompt);
  if (!process.stdin.isTTY) return runHeadless(config, trace, await readPipedInput());
  return runInteractive(config, trace);
}

function describeModel(config) {
  const overrides = config.overrides.length > 0 ? ` (overridden by ${config.overrides.join(", ")})` : "";
  return `Model: ${config.model} at ${config.baseUrl}${overrides}`;
}

function openPresetFolderOrExit() {
  const preset = findPresetFolder();
  if (!preset) return;
  const problem = openPresetFolder(preset);
  if (problem) exitWithError(problem);
  workingFolderReady = true;
}

async function ensureWorkingFolder(canAsk) {
  if (workingFolderReady) return true;
  try {
    workingFolderReady = await chooseWorkingFolder({ canAsk });
  } catch (error) {
    writeError(`Could not open the working folder: ${error.message}`);
  }
  return workingFolderReady;
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
  if (!(await ensureWorkingFolder(false))) process.exit(1);
  const agent = new Agent({ config, trace });
  const succeeded = await runTask(agent, trace, task, new AbortController().signal);
  process.exit(succeeded ? 0 : 1);
}

async function runInteractive(config, trace) {
  const agent = new Agent({ config, trace });
  startTerminalInput();
  if (!workingFolderReady) writeDimLine("Working folder: not chosen yet; I will ask after your first message.");
  writeDimLine("Type /help for commands.");
  while (true) {
    const input = await readUserMessage();
    if (input === null || input.trim() === "/exit") break;
    const text = input.trim();
    if (isCommand(text)) handleCommand(agent, trace, text);
    else if (text) await runInteractiveTask(agent, trace, input);
  }
  process.exit(0);
}

function isCommand(text) {
  return text.startsWith("/") && !text.includes("\n");
}

async function runInteractiveTask(agent, trace, text) {
  if (!(await ensureWorkingFolder(true))) return;
  const controller = new AbortController();
  const stopWatching = watchForInterrupt(() => controller.abort());
  await runTask(agent, trace, text, controller.signal);
  stopWatching();
}

async function runTask(agent, trace, text, signal) {
  const startedAt = Date.now();
  try {
    const stats = await agent.runTask(text, signal);
    const result = { ...stats, seconds: (Date.now() - startedAt) / 1000 };
    writeFooter(result);
    trace.recordTaskEnd(result);
    if (result.outcome !== "done") writeError(`Outcome: ${result.outcome}`);
    return result.outcome === "done";
  } catch (error) {
    if (signal.aborted) writeDimLine("[interrupted]");
    else writeError(`Error: ${error.message}`);
    return false;
  }
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
