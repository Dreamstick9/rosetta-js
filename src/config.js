import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONFIG_URL = new URL("../config.json", import.meta.url);
const TEXT_FIELDS = ["baseUrl", "model"];
const POLICIES = ["standard", "off"];
const NUMBER_FIELDS = [
  "maxContextTokens", "maxOutputTokens", "temperature", "topP", "maxTurns", "maxSessionUsd",
  "pricing.inputPerMTok", "pricing.cachedInputPerMTok", "pricing.outputPerMTok",
  "context.maxToolOutputBytes", "context.compactStartShare", "context.compactTargetShare", "context.keptToolResults",
  "agent.maxEmptyReplyNudges", "agent.maxCheckRounds", "agent.failureTailLines",
  "timeouts.commandSeconds", "timeouts.testCheckSeconds", "timeouts.streamStallSeconds",
  "retries.maxRetries", "retries.maxStallRetries", "retries.baseBackoffMs", "retries.maxRetryAfterMs",
  "tools.maxSearchMatches", "tools.maxSearchLineLength", "tools.listDepth", "tools.readLineLimit",
  "skills.maxInstructionTokens", "skills.maxCatalogSkills", "skills.maxDescriptionChars", "skills.maxSkillFiles",
  "intake.maxComments", "intake.maxBodyChars", "intake.maxCommentChars", "intake.cloneDepth",
  "intake.apiTimeoutSeconds", "intake.gitTimeoutSeconds", "skills.maxAuto", "digest.minLines",
];
const AGENT_NUMBER_FIELDS = [
  "agents.maxParallelAgents", "agents.explorerMaxTurns", "agents.workerMaxTurns", "agents.reviewerMaxTurns",
  "agents.explorerMaxUsd", "agents.workerMaxUsd", "agents.reviewerMaxUsd",
  "agents.fanOutMinItems", "agents.fanOutMinFiles", "agents.tournamentSize",
];
const BOOLEAN_FIELDS = ["exitAfterTask", "agents.reviewerEnabled", "agents.autoTournament", "skills.internal", "skills.detect", "digest.enabled"];

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
  for (const field of [...NUMBER_FIELDS, ...AGENT_NUMBER_FIELDS]) {
    if (typeof readField(config, field) !== "number") failField(field, "a number");
  }
  if (config.seed !== null && !Number.isInteger(config.seed)) failField("seed", "an integer or null");
  if (!POLICIES.includes(config.policy)) failField("policy", `one of ${POLICIES.join(", ")}`);
  for (const field of BOOLEAN_FIELDS) {
    if (typeof readField(config, field) !== "boolean") failField(field, "true or false");
  }
}

function readField(config, field) {
  let value = config;
  for (const key of field.split(".")) value = value?.[key];
  return value;
}

function failField(field, expected) {
  console.error(`config.json: "${field}" must be ${expected}.`);
  process.exit(1);
}
