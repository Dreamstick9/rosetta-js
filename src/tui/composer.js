import { charWidth } from "./text.js";

const PASTE_PLACEHOLDER_CHARS = 1000;
const INLINE_CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]|\x1b\[[0-?]*[ -/]*[@-~]/g;

export class Composer {
  constructor() {
    this.history = [];
    this.historyIndex = -1;
    this.draft = null;
    this.clear();
  }

  clear() {
    this.setText("");
    this.historyIndex = -1;
  }

  setText(text, pastes = new Map()) {
    this.text = text;
    this.cursor = text.length;
    this.pastes = new Map(pastes);
  }

  isEmpty() {
    return this.text.length === 0;
  }

  insert(value) {
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
    this.cursor += value.length;
  }

  insertPaste(raw) {
    const text = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (text.length < PASTE_PLACEHOLDER_CHARS) return this.insert(text.replaceAll("\t", "    ").replace(INLINE_CONTROL_PATTERN, ""));
    let label = `[Pasted Content ${text.length} chars]`;
    for (let count = 2; this.pastes.has(label); count++) label = `[Pasted Content ${text.length} chars #${count}]`;
    this.pastes.set(label, text);
    this.insert(label);
  }

  replaceRange(start, end, value) {
    this.text = this.text.slice(0, start) + value + this.text.slice(end);
    this.cursor = start + value.length;
  }

  deleteRange(start, end) {
    this.replaceRange(start, end, "");
    for (const label of this.pastes.keys()) {
      if (!this.text.includes(label)) this.pastes.delete(label);
    }
  }

  backspace() {
    if (this.cursor === 0) return;
    const before = this.text.slice(0, this.cursor);
    const label = [...this.pastes.keys()].find((key) => before.endsWith(key));
    this.deleteRange(this.cursor - (label ? label.length : previousCharLength(before)), this.cursor);
  }

  deleteForward() {
    const after = this.text.slice(this.cursor);
    if (!after) return;
    const label = [...this.pastes.keys()].find((key) => after.startsWith(key));
    this.deleteRange(this.cursor, this.cursor + (label ? label.length : nextCharLength(after)));
  }

  moveLeft() {
    this.cursor -= previousCharLength(this.text.slice(0, this.cursor));
  }

  moveRight() {
    this.cursor += nextCharLength(this.text.slice(this.cursor));
  }

  wordLeft() {
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.text[index - 1])) index--;
    while (index > 0 && !/\s/.test(this.text[index - 1])) index--;
    this.cursor = index;
  }

  wordRight() {
    let index = this.cursor;
    while (index < this.text.length && /\s/.test(this.text[index])) index++;
    while (index < this.text.length && !/\s/.test(this.text[index])) index++;
    this.cursor = index;
  }

  deleteWordBack() {
    const end = this.cursor;
    this.wordLeft();
    this.deleteRange(this.cursor, end);
  }

  lineStart() {
    return this.text.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  lineEnd() {
    const index = this.text.indexOf("\n", this.cursor);
    return index === -1 ? this.text.length : index;
  }

  killToLineStart() {
    const start = this.lineStart();
    this.deleteRange(start === this.cursor ? Math.max(0, start - 1) : start, this.cursor);
  }

  killToLineEnd() {
    const end = this.lineEnd();
    this.deleteRange(this.cursor, end === this.cursor ? Math.min(this.text.length, end + 1) : end);
  }

  tokenBeforeCursor() {
    const before = this.text.slice(0, this.cursor);
    const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n")) + 1;
    return { start, text: before.slice(start) };
  }

  take() {
    const display = this.text;
    let text = display;
    for (const [label, content] of this.pastes) text = text.split(label).join(content);
    if (display.trim() && this.history.at(-1)?.text !== display) this.history.push({ text: display, pastes: new Map(this.pastes) });
    this.clear();
    return { text, display };
  }

  historyPrevious() {
    if (this.history.length === 0) return false;
    if (this.historyIndex === -1) {
      this.draft = { text: this.text, pastes: this.pastes };
      this.historyIndex = this.history.length;
    }
    if (this.historyIndex > 0) this.historyIndex--;
    const entry = this.history[this.historyIndex];
    this.setText(entry.text, entry.pastes);
    return true;
  }

  historyNext() {
    if (this.historyIndex === -1) return false;
    this.historyIndex++;
    const entry = this.historyIndex < this.history.length ? this.history[this.historyIndex] : this.draft;
    if (this.historyIndex >= this.history.length) this.historyIndex = -1;
    this.setText(entry.text, entry.pastes);
    return true;
  }

  layout(availableWidth) {
    const rows = [""];
    const positions = [];
    let row = 0;
    let column = 0;
    let index = 0;
    for (const char of this.text) {
      if (char === "\n") {
        positions.push({ index, row, column });
        rows.push("");
        row++;
        column = 0;
        index++;
        continue;
      }
      const width = charWidth(char);
      if (column + width > availableWidth && column > 0) {
        rows.push("");
        row++;
        column = 0;
      }
      positions.push({ index, row, column });
      rows[row] += char;
      column += width;
      index += char.length;
    }
    positions.push({ index, row, column });
    const cursor = positions.find((position) => position.index === this.cursor) ?? positions.at(-1);
    return { rows, positions, cursor };
  }

  moveVertical(direction, availableWidth) {
    const { positions, cursor } = this.layout(availableWidth);
    const candidates = positions.filter((position) => position.row === cursor.row + direction);
    if (candidates.length === 0) return false;
    const target = candidates.filter((position) => position.column <= cursor.column).at(-1) ?? candidates[0];
    this.cursor = target.index;
    return true;
  }
}

function previousCharLength(text) {
  if (!text) return 0;
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xdc00 && code <= 0xdfff && text.length > 1 ? 2 : 1;
}

function nextCharLength(text) {
  if (!text) return 0;
  const code = text.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff && text.length > 1 ? 2 : 1;
}
