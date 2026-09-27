const SGR = {
  bold: "1", dim: "2", italic: "3", underline: "4",
  red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", gray: "90",
};
const USE_COLOR = !process.env.NO_COLOR;
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g;
const ELLIPSIS = "…";

export const TRUE_COLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? "");

export function style(...names) {
  return names.map((name) => SGR[name] ?? name).join(";");
}

export function rgb(red, green, blue) {
  return `38;2;${red};${green};${blue}`;
}

export function span(text, styleCode = "") {
  return { text, style: styleCode };
}

export function sanitize(text) {
  return String(text)
    .replace(ANSI_PATTERN, "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replaceAll("\t", "    ")
    .replace(CONTROL_PATTERN, "");
}

export function charWidth(char) {
  const code = char.codePointAt(0);
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  return isWide(code) ? 2 : 1;
}

function isWide(code) {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

export function textWidth(text) {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

export function spansWidth(spans) {
  return spans.reduce((total, part) => total + textWidth(part.text), 0);
}

function pushSpan(line, text, styleCode, fixed) {
  const last = line.at(-1);
  if (last && line.length > fixed && last.style === styleCode) last.text += text;
  else line.push(span(text, styleCode));
}

function trimTrailingSpace(line, fixed) {
  while (line.length > fixed && /\s$/.test(line.at(-1).text)) {
    line.at(-1).text = line.at(-1).text.trimEnd();
    if (!line.at(-1).text) line.pop();
  }
}

function tokenize(spans) {
  const tokens = [];
  for (const part of spans) {
    for (const piece of part.text.split(/(\s+)/)) {
      if (piece) tokens.push({ text: piece, style: part.style, width: textWidth(piece), space: /^\s+$/.test(piece) });
    }
  }
  return tokens;
}

export function wrapSpans(spans, width, firstPrefix = [], restPrefix = firstPrefix) {
  const restWidth = spansWidth(restPrefix);
  const limit = Math.max(width, restWidth + 1, spansWidth(firstPrefix) + 1);
  const lines = [];
  let line = firstPrefix.map((part) => ({ ...part }));
  let fixed = firstPrefix.length;
  let used = spansWidth(firstPrefix);
  let empty = true;
  const breakLine = () => {
    trimTrailingSpace(line, fixed);
    lines.push(line);
    line = restPrefix.map((part) => ({ ...part }));
    fixed = restPrefix.length;
    used = restWidth;
    empty = true;
  };
  const add = (text, styleCode, tokenWidth) => {
    pushSpan(line, text, styleCode, fixed);
    used += tokenWidth;
    empty = false;
  };
  for (const token of tokenize(spans)) {
    if (used + token.width <= limit) add(token.text, token.style, token.width);
    else if (token.space) breakLine();
    else if (!empty && restWidth + token.width <= limit) {
      breakLine();
      add(token.text, token.style, token.width);
    } else {
      for (const char of token.text) {
        const size = charWidth(char);
        if (used + size > limit && !empty) breakLine();
        add(char, token.style, size);
      }
    }
  }
  lines.push(line);
  return lines;
}

export function truncateSpans(spans, width) {
  if (spansWidth(spans) <= width) return spans;
  const result = [];
  let used = 0;
  for (const part of spans) {
    let text = "";
    for (const char of part.text) {
      const size = charWidth(char);
      if (used + size > width - 1) {
        result.push(span(text + ELLIPSIS, part.style));
        return result;
      }
      text += char;
      used += size;
    }
    result.push(span(text, part.style));
  }
  return result;
}

export function serialize(spans) {
  return spans.map(({ text, style: code }) => (code && USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)).join("");
}
