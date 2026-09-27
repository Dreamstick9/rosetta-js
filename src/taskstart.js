import { Agent } from "./agent.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { takeProjectSnapshot } from "./checks.js";
import { runIntake } from "./intake/index.js";
import { parseBestOf } from "./slash.js";

let sessionSnapshot = null;
let firstTaskStarted = false;

export function createMainAgent(config, trace) {
  const agent = new Agent({ config, trace });
  agent.orchestrator = new Orchestrator({ trace, loop: agent.loop });
  return agent;
}

export function chooseTaskStart(agent, trace, input) {
  const text = input.trim();
  if (text === "/resume") return (signal) => resumeTask(agent, signal);
  const bestOf = parseBestOf(text);
  if (bestOf) return (signal) => startBestOf(agent, trace, bestOf, signal);
  return (signal) => startTask(agent, trace, input, signal);
}

export async function startTask(agent, trace, text, signal) {
  const task = await prepareFirstTask(trace, text, signal);
  return agent.runTask(task, signal);
}

export async function startBestOf(agent, trace, { size, task }, signal) {
  const prepared = await prepareFirstTask(trace, task, signal);
  return agent.orchestrator.runBestOf(prepared, size, signal);
}

export async function resumeTask(agent, signal) {
  markFirstTask();
  return agent.resumeTask(signal);
}

export function readSessionSnapshot() {
  return sessionSnapshot;
}

async function prepareFirstTask(trace, text, signal) {
  if (firstTaskStarted) return text;
  const task = await runIntake(text, trace, signal);
  markFirstTask();
  return task;
}

function markFirstTask() {
  if (firstTaskStarted) return;
  firstTaskStarted = true;
  sessionSnapshot = takeProjectSnapshot();
}
