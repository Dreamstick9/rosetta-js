import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONFIG_URL = new URL("../config.json", import.meta.url);
const TEXT_FIELDS = ["baseUrl", "model"];
const NUMBER_FIELDS = [
  "maxContextTokens", "maxOutputTokens", "temperature", "topP", "maxTurns",
  "pricing.inputPerMTok", "pricing.cachedInputPerMTok", "pricing.outputPerMTok",
  "context.maxToolOutputBytes", "context.compactStartShare", "context.compactTargetShare", "context.keptToolResults",
  "agent.maxEmptyReplyNudges", "agent.maxCheckRounds", "agent.failureTailLines",
  "timeouts.commandSeconds", "timeouts.testCheckSeconds", "timeouts.streamStallSeconds",
  "retries.maxRetries", "retries.maxStallRetries", "retries.baseBackoffMs", "retries.maxRetryAfterMs",
  "tools.maxSearchMatches", "tools.maxSearchLineLength", "tools.listDepth", "tools.readLineLimit",
];

export const HARNESS_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
export let PROJECT_ROOT = process.cwd();
export const CONFIG = loadConfig();

export function setProjectRoot(folder) {
  process.chdir(folder);
  PROJECT_ROOT = process.cwd();
}

function loadConfig() {
  const fileConfig = JSON.parse(readFileSync(CONFIG_URL, "utf8"));
  const config = {
    ...fileConfig,
    baseUrl: process.env.AI_BASE_URL || fileConfig.baseUrl,
    model: process.env.AI_MODEL || fileConfig.model,
    apiKey: process.env.AI_API_KEY || "",
    overrides: listOverrides(),
  };
  checkFields(config);
  return config;
}

function listOverrides() {
  const overrides = [];
  if (process.env.AI_BASE_URL) overrides.push("AI_BASE_URL");
  if (process.env.AI_MODEL) overrides.push("AI_MODEL");
  return overrides;
}

function checkFields(config) {
  for (const field of TEXT_FIELDS) {
    if (typeof readField(config, field) !== "string" || !readField(config, field)) failField(field, "a non-empty string");
  }
  for (const field of NUMBER_FIELDS) {
    if (typeof readField(config, field) !== "number") failField(field, "a number");
  }
  if (config.seed !== null && !Number.isInteger(config.seed)) failField("seed", "an integer or null");
}

function readField(config, field) {
  let value = config;
  for (const key of field.split(".")) value = value?.[key];
  return value;
}

function failField(field, expected) {
  throw new Error(`config.json: "${field}" must be ${expected}.`);
}
