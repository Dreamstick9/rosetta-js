import fs from "node:fs";
import { LineEditor } from "./lineeditor.js";
import { writeText } from "./ui.js";

const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";

const history = [];

let inputEnded = false;
let activeEditor = null;

export function startTerminalInput() {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("end", endInput);
  process.stdin.resume();
  process.stdout.write(ENABLE_BRACKETED_PASTE);
}

export function stopTerminalInput() {
  if (!process.stdin.isRaw) return;
  process.stdout.write(DISABLE_BRACKETED_PASTE);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

export async function readHeadlessTask(args) {
  const prompt = readPromptArgument(args) ?? readIssueVariable();
  if (prompt !== null) return prompt;
  if (!process.stdin.isTTY) return readPipedInput();
  return null;
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

async function readPipedInput() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function endInput() {
  inputEnded = true;
  activeEditor?.finish(null);
}

export async function readUserMessage() {
  if (inputEnded) return null;
  writeText("\n> ");
  const message = await new Promise((resolve) => {
    activeEditor = new LineEditor(history, resolve);
  });
  activeEditor = null;
  if (message?.trim()) history.push(message);
  return message;
}

export function watchForInterrupt(onInterrupt) {
  const listener = (data) => {
    if (data === ESCAPE || data.includes(CTRL_C)) onInterrupt();
    if (data.includes(CTRL_D)) inputEnded = true;
  };
  process.stdin.on("data", listener);
  return () => process.stdin.off("data", listener);
}
