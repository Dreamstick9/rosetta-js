#!/usr/bin/env node
import readline from "node:readline";
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";

const HELP = `Commands:
  /help   show this help
  /new    clear the conversation
  /exit   quit`;

const dim = (text) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text);

function createTerminalUi() {
  let atLineStart = true;
  const write = (text) => {
    process.stdout.write(text);
    if (text) atLineStart = text.endsWith("\n");
  };
  const writeLine = (text) => write(`${atLineStart ? "" : "\n"}${text}\n`);
  return {
    write,
    writeLine,
    onText: write,
    onToolCall: (name, target, error) => writeLine(dim(formatToolLine(name, target, error))),
    onCompact: (before, after, method) => writeLine(dim(`  [context compacted: ~${before} → ~${after} tokens, ${method}]`)),
    onEmptyReply: () => writeLine(dim("  [model returned an empty reply]")),
  };
}

function formatToolLine(name, target, error) {
  const parts = [error ? "  ✗" : "  →", name, target, error && `— ${firstLine(error)}`];
  return parts.filter(Boolean).join(" ");
}

function firstLine(text) {
  return text.split("\n")[0].slice(0, 120);
}

function formatFooter(stats, seconds) {
  const mark = stats.estimated ? "~" : "";
  const parts = [`in ${mark}${stats.inputTokens}`];
  if (stats.cachedTokens) parts.push(`cached ${stats.cachedTokens}`);
  parts.push(`out ${mark}${stats.outputTokens}`, `${seconds.toFixed(1)}s`);
  return `[${parts.join(" · ")}]`;
}

async function runTurn(agent, ui, text) {
  const startedAt = Date.now();
  try {
    const stats = await agent.send(text, ui);
    ui.writeLine(dim(formatFooter(stats, (Date.now() - startedAt) / 1000)));
    return true;
  } catch (error) {
    ui.writeLine(`Error: ${error.message}${error.cause ? ` (${error.cause.message})` : ""}`);
    return false;
  }
}

function handleCommand(agent, ui, input) {
  if (input === "/help") ui.writeLine(HELP);
  else if (input === "/new") {
    agent.reset();
    ui.writeLine(dim("Conversation cleared."));
  } else ui.writeLine(`Unknown command ${input}.\n${HELP}`);
}

async function runInteractive(agent, ui) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\n> " });
  ui.writeLine(dim(`Model: ${agent.config.model}. Type /help for commands.`));
  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (input === "/exit") break;
    if (input.startsWith("/")) handleCommand(agent, ui, input);
    else if (input) await runTurn(agent, ui, input);
    rl.prompt();
  }
  rl.close();
}

function parsePromptArgument(argv) {
  const index = argv.findIndex((arg) => arg === "-p" || arg === "--prompt");
  return index === -1 ? null : argv[index + 1] ?? "";
}

async function main() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error("AI_API_KEY is not set. Export it in your environment first.");
    process.exit(1);
  }
  const agent = new Agent(config);
  const ui = createTerminalUi();
  const prompt = parsePromptArgument(process.argv.slice(2));
  if (prompt === null) return runInteractive(agent, ui);
  if (!prompt) {
    console.error('Usage: node src/cli.js -p "task"');
    process.exit(1);
  }
  process.exitCode = (await runTurn(agent, ui, prompt)) ? 0 : 1;
}

main();
