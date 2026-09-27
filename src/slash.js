import { CONFIG } from "./config.js";
import { writeCostSummary, writeDimLine, writeError, writeLine } from "./ui.js";

const HELP = `Commands:
  /help         show this help
  /new          clear the conversation
  /cost         show the session cost and token totals
  /check off    stop running the tests after changes (/check on turns it back on)
  /diff         show what changed since the session started
  /undo         put the files back to the previous checkpoint
  /best-of N task  run N workers on the task in parallel and merge the best
  /resume       continue the task saved in .rosetta/session.json
  /exit         quit
Esc or Ctrl-C stops the current turn. Ctrl-C at the prompt quits.`;

export function isCommand(text) {
  return text.startsWith("/") && !text.includes("\n");
}

export function parseBestOf(text) {
  const match = /^\/best-of\s+(\d+)\s+(\S[\s\S]*)$/.exec(text.trim());
  if (!match || Number(match[1]) < 1) return null;
  return { size: Number(match[1]), task: match[2] };
}

export function handleCommand(agent, trace, command) {
  if (command === "/help") return writeLine(HELP);
  if (command === "/cost") return writeCostSummary(trace.totals, trace.file, trace.shared.roles);
  if (command === "/new") {
    agent.reset();
    return writeDimLine("Conversation cleared.");
  }
  if (command === "/check on" || command === "/check off") {
    agent.doneCheckEnabled = command === "/check on";
    return writeDimLine(`Test check after changes is ${agent.doneCheckEnabled ? "on" : "off"}.`);
  }
  if (command === "/diff") return runSafely(() => showDiff(agent.loop));
  if (command === "/undo") return runSafely(() => undoLastCheckpoint(agent.loop));
  writeLine(`Unknown command ${command}.\n${HELP}`);
}

function runSafely(action) {
  try {
    action();
  } catch (error) {
    writeError(`Error: ${error.message}`);
  }
}

function showDiff(loop) {
  if (!loop.checkpoints.enabled || !loop.sessionStart) return writeDimLine("No checkpoint yet; the first task takes one.");
  const diff = loop.checkpoints.describeDiff(loop.sessionStart, CONFIG.loop.maxDiffLines);
  writeLine(diff.patch ? `${diff.stat}\n\n${diff.patch}` : diff.stat);
}

function undoLastCheckpoint(loop) {
  const ref = loop.checkpoints.undo();
  if (!ref) return writeDimLine("Nothing to undo.");
  writeDimLine(`Files restored to checkpoint ${ref.slice(0, 10)}.`);
}
