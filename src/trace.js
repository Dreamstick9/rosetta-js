import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT } from "./config.js";
import { addModelCall, calculateCost, createUsage } from "./usage.js";

const RUNS_DIRECTORY = fileURLToPath(new URL("../runs/", import.meta.url));
const MAIN_AGENT = { id: "main", role: "main" };

export class Trace {
  constructor(config, agent = MAIN_AGENT, shared = { file: null, totals: createUsage(), roles: new Map() }) {
    this.config = config;
    this.pricing = config.pricing;
    this.agent = agent;
    this.shared = shared;
  }

  get totals() {
    return this.shared.totals;
  }

  get file() {
    return this.shared.file;
  }

  forAgent(id, role) {
    return new Trace(this.config, { id, role }, this.shared);
  }

  recordModelCall({ ms, inputTokens, cachedTokens, outputTokens, finishReason }) {
    const cost = calculateCost(this.pricing, inputTokens, cachedTokens, outputTokens);
    const tokens = { inputTokens, cachedTokens, outputTokens };
    addModelCall(this.shared.totals, tokens, cost);
    addModelCall(this.roleUsage(), tokens, cost);
    this.write({ type: "model", ms, inputTokens, cachedTokens, outputTokens, cost: Number(cost.toFixed(8)), finishReason });
    return cost;
  }

  roleUsage() {
    const roles = this.shared.roles;
    if (!roles.has(this.agent.role)) roles.set(this.agent.role, createUsage());
    return roles.get(this.agent.role);
  }

  recordToolCall({ name, args, ms, bytes, status, reason }) {
    this.totals.toolCalls++;
    if (status === "blocked") this.totals.blockedCalls++;
    this.write({ type: "tool", name, args, ms, bytes, status, reason });
  }

  recordPromptLoad({ instructionsFile, instructionsTruncated, skills, catalogSkills, lessons }) {
    this.write({ type: "prompt", instructionsFile, instructionsTruncated, skills, catalogSkills, lessons });
  }

  recordIntake({ repo, issue, folder, checkout, ms }) {
    this.write({ type: "intake", repo, issue, folder, checkout, ms });
  }

  recordCompaction({ before, after }) {
    this.write({ type: "compaction", before, after });
  }

  recordCheckpoint({ label, ref }) {
    this.write({ type: "checkpoint", label, ref });
  }

  recordTick({ attempt, id, text, check }) {
    this.write({ type: "tick", attempt, id, text, check });
  }

  recordStall({ attempt, quietTurns, action }) {
    this.write({ type: "stall", attempt, quietTurns, action });
  }

  recordLesson({ attempt, outcome, diffStat }) {
    this.write({ type: "lesson", attempt, outcome, diffStat });
  }

  recordAttemptStart({ attempt, checkpoint, resumed }) {
    this.write({ type: "attempt_start", attempt, checkpoint, resumed });
  }

  recordAttemptEnd({ attempt, outcome, score, turns, toolCalls }) {
    this.write({ type: "attempt_end", attempt, outcome, score, turns, toolCalls });
  }

  recordGiveUp({ attempt, reason, accepted }) {
    this.write({ type: "give_up", attempt, reason, accepted });
  }

  recordResume({ attempt, checkpoint, doneItems }) {
    this.write({ type: "resume", attempt, checkpoint, doneItems });
  }

  recordAgentStart({ root, files, dependsOn }) {
    this.write({ type: "agent_start", root, files, dependsOn });
  }

  recordAgentEnd({ outcome, turns, cost, inputTokens, cachedTokens, outputTokens }) {
    this.write({ type: "agent_end", outcome, turns, cost: Number(cost.toFixed(8)), inputTokens, cachedTokens, outputTokens });
  }

  recordWave({ wave, agents, applied, conflicts, check }) {
    this.write({ type: "wave", wave, agents, applied, conflicts, check });
  }

  recordTournament({ scores, winner, merged }) {
    this.write({ type: "tournament", scores, winner, merged });
  }

  recordTaskEnd({ outcome, turns, seconds, cost, inputTokens, cachedTokens, outputTokens }) {
    this.write({ type: "task", outcome, turns, seconds: Number(seconds.toFixed(1)), cost: Number(cost.toFixed(8)), inputTokens, cachedTokens, outputTokens });
  }

  write(entry) {
    if (!this.shared.file) {
      this.shared.file = createTraceFile();
      this.write(describeSession(this.config));
    }
    const line = JSON.stringify({ time: new Date().toISOString(), agent: this.agent.id, role: this.agent.role, ...entry });
    fs.appendFileSync(this.shared.file, `${line}\n`);
  }
}

function describeSession(config) {
  return {
    type: "session",
    projectRoot: PROJECT_ROOT,
    model: config.model,
    baseUrl: config.baseUrl,
    overrides: config.overrides,
    temperature: config.temperature,
    topP: config.topP,
    seed: config.seed,
    policy: config.policy,
  };
}

function createTraceFile() {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const directory = path.join(RUNS_DIRECTORY, timestamp);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "trace.jsonl");
}
