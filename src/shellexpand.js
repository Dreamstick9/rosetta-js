import os from "node:os";

export const WORD_ENDS = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL_PARAMETER_PATTERN = /^[?$!#@*\-0-9]/;

export function readWord(cursor) {
  let word = "";
  const start = cursor.index;
  while (cursor.index < cursor.text.length && !WORD_ENDS.has(cursor.text[cursor.index])) {
    const char = cursor.text[cursor.index];
    if (char === "'") word += readSingleQuoted(cursor);
    else if (char === '"') word += readDoubleQuoted(cursor);
    else if (char === "\\") word += readEscape(cursor);
    else if (char === "$" || char === "`") word += readExpansion(cursor);
    else if (char === "~" && cursor.index === start && isTildeEnd(cursor.text[cursor.index + 1])) word += readTilde(cursor);
    else word += cursor.text[cursor.index++];
  }
  return word;
}

function isTildeEnd(char) {
  return char === undefined || char === "/" || WORD_ENDS.has(char);
}

function readTilde(cursor) {
  cursor.index++;
  return os.homedir();
}

function readSingleQuoted(cursor) {
  const end = findChar(cursor, "'", cursor.index + 1);
  const text = cursor.text.slice(cursor.index + 1, end);
  cursor.index = end + 1;
  return text;
}

function readDoubleQuoted(cursor) {
  let text = "";
  cursor.index++;
  while (cursor.index < cursor.text.length && cursor.text[cursor.index] !== '"') {
    const char = cursor.text[cursor.index];
    if (char === "\\") text += readEscape(cursor);
    else if (char === "$" || char === "`") text += readExpansion(cursor);
    else text += cursor.text[cursor.index++];
  }
  cursor.index++;
  return text;
}

function readEscape(cursor) {
  const next = cursor.text[cursor.index + 1] ?? "";
  cursor.index += 2;
  return next === "\n" ? "" : next;
}

function readExpansion(cursor) {
  const rest = cursor.text.slice(cursor.index);
  if (rest.startsWith("$((")) return skipArithmetic(cursor);
  if (rest.startsWith("$(")) return readSubstitution(cursor, 2, findClosingParen(cursor.text, cursor.index + 2));
  if (rest[0] === "`") return readSubstitution(cursor, 1, findChar(cursor, "`", cursor.index + 1));
  if (rest.startsWith("${")) return readBracedVariable(cursor);
  const name = NAME_PATTERN.exec(rest.slice(1));
  if (name) return expandVariable(cursor, name[0], 1 + name[0].length);
  if (SPECIAL_PARAMETER_PATTERN.test(rest.slice(1))) return expandVariable(cursor, null, 2);
  cursor.index++;
  return "$";
}

function skipArithmetic(cursor) {
  const end = cursor.text.indexOf("))", cursor.index + 3);
  cursor.index = end === -1 ? cursor.text.length : end + 2;
  return "0";
}

function readSubstitution(cursor, openLength, end) {
  cursor.substitutions.push(cursor.text.slice(cursor.index + openLength, end));
  cursor.index = end + 1;
  return "";
}

function readBracedVariable(cursor) {
  const end = findChar(cursor, "}", cursor.index + 2);
  const inner = cursor.text.slice(cursor.index + 2, end);
  cursor.index = end + 1;
  const name = NAME_PATTERN.exec(inner)?.[0];
  if (!name) return "";
  cursor.variables.push(name);
  const value = cursor.environment[name] ?? "";
  if (value === "" && inner.startsWith(`${name}:-`)) return inner.slice(name.length + 2);
  return value;
}

function expandVariable(cursor, name, length) {
  cursor.index += length;
  if (!name) return "";
  cursor.variables.push(name);
  return cursor.environment[name] ?? "";
}

function findChar(cursor, char, from) {
  const index = cursor.text.indexOf(char, from);
  return index === -1 ? cursor.text.length : index;
}

function findClosingParen(text, start) {
  let depth = 1;
  let quote = null;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0) return index;
  }
  return text.length;
}
