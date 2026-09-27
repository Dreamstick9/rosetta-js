const CLOSERS = { "{": "}", "[": "]" };
const PYTHON_WORDS = { True: "true", False: "false", None: "null" };
const STRING_ESCAPES = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

export function parseJsonLoose(text) {
  const trimmed = stripFence(String(text).trim());
  const strict = tryParse(trimmed);
  if (strict.ok) return { value: strict.value, repaired: false };
  const loose = tryParse(rewriteJson(trimmed));
  if (loose.ok) return { value: loose.value, repaired: true };
  return null;
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function stripFence(text) {
  const match = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : text;
}

function rewriteJson(text) {
  const state = { out: "", quote: null, stack: [] };
  for (let i = 0; i < text.length; i++) {
    if (state.quote) i = copyStringChar(text, i, state);
    else i = copyStructureChar(text, i, state);
  }
  if (state.quote) state.out += '"';
  dropTrailingComma(state);
  while (state.stack.length > 0) state.out += CLOSERS[state.stack.pop()];
  return state.out;
}

function copyStringChar(text, i, state) {
  const char = text[i];
  if (char === "\\") {
    const next = text[i + 1] ?? "";
    state.out += next === "'" && state.quote === "'" ? "'" : `\\${next}`;
    return i + 1;
  }
  if (char === state.quote) {
    state.out += '"';
    state.quote = null;
  } else if (char === '"') {
    state.out += '\\"';
  } else {
    state.out += STRING_ESCAPES[char] ?? char;
  }
  return i;
}

function copyStructureChar(text, i, state) {
  const char = text[i];
  if (char === '"' || char === "'") {
    state.quote = char;
    state.out += '"';
    return i;
  }
  if (CLOSERS[char]) state.stack.push(char);
  if (char === "}" || char === "]") {
    dropTrailingComma(state);
    state.stack.pop();
  }
  if (/[A-Za-z]/.test(char)) return copyWord(text, i, state);
  state.out += char;
  return i;
}

function copyWord(text, i, state) {
  const word = text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)[0];
  const isKey = /^\s*:/.test(text.slice(i + word.length));
  state.out += isKey ? `"${word}"` : PYTHON_WORDS[word] ?? word;
  return i + word.length - 1;
}

function dropTrailingComma(state) {
  state.out = state.out.replace(/,\s*$/, "");
}
