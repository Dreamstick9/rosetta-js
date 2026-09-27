import { CONFIG } from "./config.js";

const AGENTS = CONFIG.agents;
const READING_TOOLS = ["list_files", "read_file", "search", "bash", "web_search", "web_fetch"];
const ALL_TOOLS = ["list_files", "read_file", "create_file", "write_file", "edit_file", "delete_file", "search", "bash", "skill", "web_search", "web_fetch"];
const MAIN_TOOLS = [...ALL_TOOLS, "todo", "give_up", "task"];

export const ROLES = {
  main: {
    name: "main",
    prompt: "You are the main agent. You own the task from start to finish.",
    tools: MAIN_TOOLS,
    readOnly: false,
    maxTurns: CONFIG.maxTurns,
    maxUsd: CONFIG.maxSessionUsd,
    enabled: true,
  },
  explorer: {
    name: "explorer",
    prompt: [
      "You are an explorer. You read the code and report what you find; you never change anything.",
      "Use bash only for read-only commands such as ls, cat, git log or running a script that prints.",
      "Finish with a short list of findings: file paths, line numbers and the facts that answer the question.",
    ].join("\n"),
    tools: READING_TOOLS,
    readOnly: true,
    maxTurns: AGENTS.explorerMaxTurns,
    maxUsd: AGENTS.explorerMaxUsd,
    enabled: true,
  },
  worker: {
    name: "worker",
    prompt: [
      "You are a worker. You do one piece of the task in your own private copy of the project.",
      "Change only what your piece needs, run the relevant tests, and do not touch files outside your copy.",
      "Finish with one short paragraph: what you changed, which files, and how you checked it.",
    ].join("\n"),
    tools: ALL_TOOLS,
    readOnly: false,
    maxTurns: AGENTS.workerMaxTurns,
    maxUsd: AGENTS.workerMaxUsd,
    enabled: true,
  },
  reviewer: {
    name: "reviewer",
    prompt: [
      "You are a reviewer. You check a finished change; you never edit files.",
      "Start your answer with the verdict on its own line: APPROVE or REJECT.",
      "Then list the concrete problems, most important first, with file paths.",
    ].join("\n"),
    tools: READING_TOOLS,
    readOnly: true,
    maxTurns: AGENTS.reviewerMaxTurns,
    maxUsd: AGENTS.reviewerMaxUsd,
    enabled: AGENTS.reviewerEnabled,
  },
};

export function getRole(name) {
  if (!Object.hasOwn(ROLES, name)) throw new Error(`unknown role '${name}'. Roles: ${Object.keys(ROLES).join(", ")}`);
  return ROLES[name];
}

export function describeToolRefusal(roleName, toolName) {
  if (!roleName) return null;
  if (getRole(roleName).tools.includes(toolName)) return null;
  return `tool ${toolName} is not available to the ${roleName} role`;
}

export function isReadOnlyRole(roleName) {
  if (!roleName) return false;
  return getRole(roleName).readOnly;
}
