import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { findSummarizer } from "./summarizers.js";
import { builtinDigest } from "./builtin.js";
import { firstLines, runSkillScript } from "../skills-internal/run-script.js";
import { writeDimLine } from "../ui.js";

const MAX_DIGEST_LINES = 40;
const TRAILER_LINE = /^\[.*\]$/;

let savedOutputs = 0;

export function digestOutput(command, output, outputDirectory) {
  if (!CONFIG.digest.enabled || !outputDirectory) return output;
  const { body, trailer } = splitTrailer(output);
  const lineCount = body.split("\n").length;
  if (lineCount <= CONFIG.digest.minLines) return output;
  const summarizer = findSummarizer(command, body);
  if (!summarizer) return output;
  const file = saveOutput(outputDirectory, body);
  const digest = summarize(summarizer, body, file);
  const digestLineCount = digest ? digest.split("\n").length : lineCount;
  if (digestLineCount * 2 > lineCount) return output;
  writeDimLine(`✂ digest: ${summarizer.name} ${lineCount} → ${digestLineCount} lines`);
  return [digest, ...trailer, `[digest of ${lineCount} lines; full output: ${file} (read_file if needed)]`].join("\n");
}

function splitTrailer(output) {
  const lines = output.split("\n");
  let end = lines.length;
  while (end > 0 && TRAILER_LINE.test(lines[end - 1])) end--;
  return { body: lines.slice(0, end).join("\n"), trailer: lines.slice(end) };
}

function saveOutput(directory, text) {
  fs.mkdirSync(directory, { recursive: true });
  savedOutputs++;
  const file = path.join(directory, `${savedOutputs}.txt`);
  fs.writeFileSync(file, text);
  return file;
}

function summarize(summarizer, body, file) {
  const scriptOutput = runSkillScript(summarizer.skill, summarizer.script, summarizer.logArgs(file));
  const digest = scriptOutput ? dropFileMentions(scriptOutput, file) : builtinDigest(summarizer.name, body);
  if (!digest) return null;
  return firstLines(digest, MAX_DIGEST_LINES);
}

function dropFileMentions(text, file) {
  return text.split("\n").filter((line) => !line.includes(file)).join("\n").trim();
}
