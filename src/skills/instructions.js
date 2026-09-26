import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "../context.js";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const TRUNCATED_MARKER = "[truncated]";

export function readProjectInstructions(projectRoot, maxTokens) {
  for (const file of INSTRUCTION_FILES) {
    const text = readText(path.join(projectRoot, file)).trim();
    if (!text) continue;
    const capped = capToTokens(text, maxTokens);
    return { file, text: capped, truncated: capped !== text };
  }
  return null;
}

export function capToTokens(text, maxTokens) {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  const keptChars = Math.floor((text.length * maxTokens) / tokens) - TRUNCATED_MARKER.length - 1;
  const cut = text.slice(0, Math.max(0, keptChars));
  const lastNewline = cut.lastIndexOf("\n");
  const kept = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return `${kept}\n${TRUNCATED_MARKER}`;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
