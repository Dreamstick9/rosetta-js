const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CSI_LETTERS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab" };
const TILDE_KEYS = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };
const CODE_KEYS = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace" };

export class KeyParser {
  constructor() {
    this.paste = null;
  }

  feed(data) {
    if (this.paste === null && looksLikeUnbracketedPaste(data)) return [{ name: "paste", text: data }];
    const events = [];
    let index = 0;
    while (index < data.length) {
      if (this.paste !== null) {
        const end = data.indexOf(PASTE_END, index);
        if (end === -1) {
          this.paste += data.slice(index);
          break;
        }
        events.push({ name: "paste", text: this.paste + data.slice(index, end) });
        this.paste = null;
        index = end + PASTE_END.length;
      } else if (data.startsWith(PASTE_START, index)) {
        this.paste = "";
        index += PASTE_START.length;
      } else {
        const [event, length] = readKey(data, index);
        events.push(event);
        index += length;
      }
    }
    return events;
  }
}

function looksLikeUnbracketedPaste(data) {
  return data.length > 2 && !data.includes("\x1b") && /[\r\n]/.test(data.slice(0, -1));
}

function readKey(data, index) {
  const char = data[index];
  if (char === "\x1b") return readEscape(data, index);
  if (char === "\r") return [{ name: "enter" }, 1];
  if (char === "\n") return [{ name: "j", ctrl: true }, 1];
  if (char === "\t") return [{ name: "tab" }, 1];
  if (char === "\x7f" || char === "\b") return [{ name: "backspace" }, 1];
  const code = char.charCodeAt(0);
  if (code < 32) return [{ name: String.fromCharCode(code + 96), ctrl: true }, 1];
  const text = String.fromCodePoint(data.codePointAt(index));
  return [{ name: text, text }, text.length];
}

function readEscape(data, index) {
  const next = data[index + 1];
  if (next === undefined || next === "\x1b") return [{ name: "escape" }, 1];
  if (next === "[") return readCsi(data, index);
  if (next === "O" && data[index + 2]) return [{ name: CSI_LETTERS[data[index + 2]] ?? "unknown" }, 3];
  const [inner, length] = readKey(data, index + 1);
  return [{ ...inner, alt: true, text: undefined }, length + 1];
}

function readCsi(data, index) {
  let end = index + 2;
  while (end < data.length && !isFinalByte(data.charCodeAt(end))) end++;
  if (end >= data.length) return [{ name: "unknown" }, data.length - index];
  const params = data.slice(index + 2, end).split(";");
  const final = data[end];
  const length = end - index + 1;
  const modifiers = readModifiers(params[1]);
  if (CSI_LETTERS[final]) return [{ name: CSI_LETTERS[final], ...modifiers, shift: modifiers.shift || final === "Z" }, length];
  if (final === "~" && params[0] === "27") return [keyFromCode(Number(params[2]), readModifiers(params[1])), length];
  if (final === "~") return [{ name: TILDE_KEYS[params[0]] ?? "unknown", ...modifiers }, length];
  if (final === "u") return [keyFromCode(Number(params[0].split(":")[0]), modifiers), length];
  return [{ name: "unknown" }, length];
}

function isFinalByte(code) {
  return code >= 0x40 && code <= 0x7e;
}

function readModifiers(field) {
  const bits = field ? Number(field.split(":")[0]) - 1 : 0;
  return { shift: Boolean(bits & 1), alt: Boolean(bits & 2), ctrl: Boolean(bits & 4) };
}

function keyFromCode(code, modifiers) {
  if (CODE_KEYS[code]) return { name: CODE_KEYS[code], ...modifiers };
  const char = String.fromCodePoint(code || 63);
  const plain = !modifiers.ctrl && !modifiers.alt;
  return { name: char.toLowerCase(), ...modifiers, text: plain ? (modifiers.shift ? char.toUpperCase() : char) : undefined };
}
