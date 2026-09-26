const FENCE = "---";
const FIELD_PATTERN = /^([A-Za-z_][\w-]*):\s*(.*)$/;
const BLOCK_MARKER_PATTERN = /^[>|][+-]?$/;
const NAME_PATTERN = /^[A-Za-z0-9][\w.-]*$/;

export function parseSkillFile(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0].trim() !== FENCE) return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (end === -1) return null;
  const fields = readFields(lines.slice(1, end));
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!NAME_PATTERN.test(name) || !description) return null;
  const skill = { name, description, body: lines.slice(end + 1).join("\n").trim() };
  return fields.get("internal") === "true" ? { ...skill, internal: true } : skill;
}

function readFields(lines) {
  const fields = new Map();
  let index = 0;
  while (index < lines.length) {
    const match = FIELD_PATTERN.exec(lines[index]);
    index++;
    if (!match) continue;
    const continuation = [];
    while (index < lines.length && isContinuation(lines[index])) {
      continuation.push(lines[index].trim());
      index++;
    }
    fields.set(match[1], readValue(match[2].trim(), continuation));
  }
  return fields;
}

function isContinuation(line) {
  return line.trim() === "" || /^\s/.test(line);
}

function readValue(firstLine, continuation) {
  const parts = BLOCK_MARKER_PATTERN.test(firstLine) ? continuation : [firstLine, ...continuation];
  const joined = parts.filter(Boolean).join(" ");
  return unquote(joined).replace(/\s+/g, " ").trim();
}

function unquote(value) {
  if (value.length < 2) return value;
  const quote = value[0];
  if (value.at(-1) !== quote) return value;
  if (quote === '"') return value.slice(1, -1).replaceAll('\\"', '"');
  if (quote === "'") return value.slice(1, -1).replaceAll("''", "'");
  return value;
}
