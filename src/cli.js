#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { Trace } from "./trace.js";
import { stopShell } from "./tools/shell.js";
import { askApproval, readPipedInput, readUserMessage, startTerminalInput, stopTerminalInput, watchForInterrupt } from "./input.js";
import { writeCostSummary, writeDimLine, writeError, writeFooter, writeLine } from "./ui.js";

const HELP = `Commands:
  /help         show this help
  /new          clear the conversation
  /cost         show the session cost and token totals
  /check off    stop running the tests after changes (/check on turns it back on)
  /exit         quit
Esc or Ctrl-C stops the current turn. Ctrl-C at the prompt quits.`;

async function main() {
  const config = loadConfig();
  if (!config.apiKey) exitWithError("AI_API_KEY is not set. Export it in your environment first.");
  process.on("exit", cleanUp);
  const trace = new Trace(config.pricing);
  const prompt = readPromptArgument(process.argv.slice(2));
  if (prompt !== null) return runHeadless(config, trace, prompt);
  if (!process.stdin.isTTY) return runHeadless(config, trace, await readPipedInput());
  return runInteractive(config, trace);
}

function readPromptArgument(args) {
  const index = args.findIndex((arg) => arg === "-p" || arg === "--prompt");
  if (index === -1) return null;
  return args[index + 1] ?? "";
}

async function runHeadless(config, trace, task) {
  if (!task.trim()) exitWithError('Usage: node src/cli.js -p "task"   (or pipe the task on stdin)');
  const agent = new Agent({ config, trace, approve: async () => false });
  const succeeded = await runTask(agent, task, new AbortController().signal);
  process.exit(succeeded ? 0 : 1);
}

async function runInteractive(config, trace) {
  const agent = new Agent({ config, trace, approve: createInteractiveApprover() });
  startTerminalInput();
  writeDimLine(`Model: ${config.model}. Type /help for commands.`);
  while (true) {
    const input = await readUserMessage();
    if (input === null || input.trim() === "/exit") break;
    const text = input.trim();
    if (isCommand(text)) handleCommand(agent, trace, text);
    else if (text) await runInteractiveTask(agent, input);
  }
  process.exit(0);
}

function isCommand(text) {
  return text.startsWith("/") && !text.includes("\n");
}

async function runInteractiveTask(agent, text) {
  const controller = new AbortController();
  const stopWatching = watchForInterrupt(() => controller.abort());
  await runTask(agent, text, controller.signal);
  stopWatching();
}

async function runTask(agent, text, signal) {
  const startedAt = Date.now();
  try {
    const stats = await agent.runTask(text, signal);
    writeFooter({ ...stats, seconds: (Date.now() - startedAt) / 1000 });
    return true;
  } catch (error) {
    if (signal.aborted) writeDimLine("[interrupted]");
    else writeError(`Error: ${error.message}`);
    return false;
  }
}

function createInteractiveApprover() {
  const alwaysAllowed = new Set();
  return async function approve(command, reason, signal) {
    if (alwaysAllowed.has(reason)) return true;
    const answer = await askApproval(`  ! ${reason}: ${command}`, signal);
    if (answer === "always") alwaysAllowed.add(reason);
    return answer !== "no";
  };
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
