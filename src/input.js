import { writeDimLine, writeText } from "./ui.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
const PASTE_FALLBACK_MS = 30;
const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const ENTER_KEYS = new Set(["\r", "\n"]);
const BACKSPACE_KEYS = new Set(["\x7f", "\b"]);
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";

const history = [];

export function startTerminalInput() {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdout.write(ENABLE_BRACKETED_PASTE);
}

export function stopTerminalInput() {
  if (!process.stdin.isRaw) return;
  process.stdout.write(DISABLE_BRACKETED_PASTE);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

export async function readPipedInput() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

export async function readUserMessage() {
  writeText("\n> ");
  const message = await new Promise((resolve) => new LineEditor(resolve));
  if (message?.trim()) history.push(message);
  return message;
}

export function watchForInterrupt(onInterrupt) {
  const listener = (data) => {
    if (data === ESCAPE || data.includes(CTRL_C)) onInterrupt();
  };
  process.stdin.on("data", listener);
  return () => process.stdin.off("data", listener);
}

class LineEditor {
  constructor(onDone) {
    this.onDone = onDone;
    this.listener = (data) => this.handleData(data);
    this.segments = [];
    this.pasteText = null;
    this.submitTimer = null;
    this.sawFastEnter = false;
    this.finished = false;
    this.historyIndex = history.length;
    process.stdin.on("data", this.listener);
  }

  handleData(data) {
    let rest = data;
    while (rest.length > 0 && !this.finished) rest = this.consume(rest);
  }

  consume(rest) {
    if (this.pasteText !== null) return this.consumePaste(rest);
    if (this.submitTimer) this.keepEnterAsNewline();
    if (rest.startsWith(PASTE_START)) {
      this.pasteText = "";
      return rest.slice(PASTE_START.length);
    }
    if (rest.startsWith(ARROW_UP)) return this.browseHistory(-1, rest);
    if (rest.startsWith(ARROW_DOWN)) return this.browseHistory(1, rest);
    if (rest.startsWith(ESCAPE)) return skipEscapeSequence(rest);
    const key = String.fromCodePoint(rest.codePointAt(0));
    this.handleKey(key);
    return rest.slice(key.length);
  }

  consumePaste(rest) {
    const endIndex = rest.indexOf(PASTE_END);
    if (endIndex === -1) {
      this.pasteText += rest;
      return "";
    }
    this.addPaste(this.pasteText + rest.slice(0, endIndex));
    this.pasteText = null;
    return rest.slice(endIndex + PASTE_END.length);
  }

  addPaste(text) {
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lineCount = normalized.split("\n").length;
    this.addSegment(normalized, lineCount === 1 ? normalized : `(pasted ${lineCount} lines) `);
  }

  browseHistory(step, rest) {
    const index = this.historyIndex + step;
    if (index < 0 || index > history.length) return rest.slice(ARROW_UP.length);
    this.historyIndex = index;
    while (this.segments.length > 0) this.removeLastSegment();
    if (index < history.length) this.addPaste(history[index]);
    return rest.slice(ARROW_UP.length);
  }

  handleKey(key) {
    if (ENTER_KEYS.has(key)) this.submitTimer = setTimeout(() => this.submit(), PASTE_FALLBACK_MS);
    else if (key === CTRL_C) this.finish(null);
    else if (key === CTRL_D && this.segments.length === 0) this.finish(null);
    else if (BACKSPACE_KEYS.has(key)) this.removeLastSegment();
    else if (key.codePointAt(0) >= 32) this.addSegment(key, key);
  }

  keepEnterAsNewline() {
    clearTimeout(this.submitTimer);
    this.submitTimer = null;
    this.sawFastEnter = true;
    this.addSegment("\n", "\n");
  }

  submit() {
    const text = this.segments.map((segment) => segment.text).join("");
    writeText("\n");
    if (this.sawFastEnter) writeDimLine(`(pasted ${text.split("\n").length} lines)`);
    this.finish(text);
  }

  addSegment(text, shown) {
    this.segments.push({ text, shown });
    writeText(shown);
  }

  removeLastSegment() {
    const segment = this.segments.pop();
    if (segment) writeText("\b \b".repeat(segment.shown.length));
  }

  finish(text) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.submitTimer);
    process.stdin.off("data", this.listener);
    if (text === null) writeText("\n");
    this.onDone(text);
  }
}

function skipEscapeSequence(text) {
  if (text[1] !== "[" && text[1] !== "O") return text.slice(2);
  let index = 2;
  while (index < text.length && !isFinalEscapeCharacter(text[index])) index++;
  return text.slice(index + 1);
}

function isFinalEscapeCharacter(char) {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}
