import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT } from "./config.js";

const TOKENS_PER_MILLION = 1_000_000;
const RUNS_DIRECTORY = fileURLToPath(new URL("../runs/", import.meta.url));

export class Trace {
  constructor(config) {
    this.config = config;
    this.pricing = config.pricing;
    this.file = null;
    this.totals = { modelCalls: 0, toolCalls: 0, blockedCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 };
  }

  recordModelCall({ ms, inputTokens, cachedTokens, outputTokens, finishReason }) {
    const cost = calculateCost(this.pricing, inputTokens, cachedTokens, outputTokens);
    this.totals.modelCalls++;
    this.totals.inputTokens += inputTokens;
    this.totals.cachedTokens += cachedTokens;
    this.totals.outputTokens += outputTokens;
    this.totals.cost += cost;
    this.write({ type: "model", ms, inputTokens, cachedTokens, outputTokens, cost: Number(cost.toFixed(8)), finishReason });
    return cost;
  }

  recordToolCall({ name, args, ms, bytes, status, reason }) {
    this.totals.toolCalls++;
    if (status === "blocked") this.totals.blockedCalls++;
    this.write({ type: "tool", name, args, ms, bytes, status, reason });
  }

  recordCompaction({ before, after }) {
    this.write({ type: "compaction", before, after });
  }

  recordTaskEnd({ outcome, turns, seconds, cost, inputTokens, cachedTokens, outputTokens }) {
    this.write({ type: "task", outcome, turns, seconds: Number(seconds.toFixed(1)), cost: Number(cost.toFixed(8)), inputTokens, cachedTokens, outputTokens });
  }

  write(entry) {
    if (!this.file) {
      this.file = createTraceFile();
      this.write(describeSession(this.config));
    }
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    fs.appendFileSync(this.file, `${line}\n`);
  }
}

export function readTokenCounts(usage, estimatedInputTokens, estimatedOutputTokens) {
  if (!usage) return { inputTokens: estimatedInputTokens, cachedTokens: 0, outputTokens: estimatedOutputTokens };
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
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

function calculateCost(pricing, inputTokens, cachedTokens, outputTokens) {
  const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
  const inputCost = uncachedTokens * pricing.inputPerMTok + cachedTokens * pricing.cachedInputPerMTok;
  const outputCost = outputTokens * pricing.outputPerMTok;
  return (inputCost + outputCost) / TOKENS_PER_MILLION;
}

function createTraceFile() {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const directory = path.join(RUNS_DIRECTORY, timestamp);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "trace.jsonl");
}
