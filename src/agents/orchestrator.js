import { CONFIG, PROJECT_ROOT } from "../config.js";
import { findTestCommand, runDoneCheck } from "../checks.js";
import { getRole } from "../roles.js";
import { createTurnStats } from "../turns.js";
import { applyFanOutRule, linkDependencies, pickWave } from "./graph.js";
import { describeCheck, formatResult } from "./results.js";
import { runSubagent } from "./subagent.js";
import { runTournament } from "./tournament.js";
import { changedFiles, createWorkspace, mergeWorkspace, removeWorkspace } from "./workspace.js";

export class Orchestrator {
  constructor({ trace, loop, runAgent = runSubagent, settings = CONFIG.agents }) {
    this.trace = trace;
    this.loop = loop;
    this.runAgent = runAgent;
    this.settings = settings;
    this.runId = `run-${Date.now()}-${process.pid}`;
    this.agentCount = 0;
    this.finished = new Map();
  }

  async runTasks(requests, signal) {
    const items = requests.map((request) => ({ ...request, agentId: null, result: null }));
    linkDependencies(items, this.finished);
    applyFanOutRule(items, this.settings);
    await this.runWaves(items.filter((item) => item.result === null), signal);
    return items.map((item) => item.result);
  }

  async runWaves(pending, signal) {
    let remaining = pending;
    let wave = 0;
    while (remaining.length > 0) {
      const stop = this.describeStop(signal);
      const ready = stop ? [] : pickWave(remaining, this.settings.maxParallelAgents);
      if (ready.length === 0) {
        for (const item of remaining) item.result = `Not started: ${stop ?? "its depends_on forms a cycle"}.`;
        return;
      }
      wave++;
      await this.runWave(ready, wave, signal);
      remaining = remaining.filter((item) => item.result === null);
    }
  }

  describeStop(signal) {
    if (signal.aborted) return "the run was interrupted";
    if (this.trace.totals.cost >= CONFIG.maxSessionUsd) return `the session cost reached maxSessionUsd ($${CONFIG.maxSessionUsd})`;
    return null;
  }

  async runWave(ready, wave, signal) {
    const runs = await Promise.all(ready.map((item) => this.launch(item, signal)));
    const merges = ready.map((item, index) => this.finishItem(item, runs[index], signal));
    const applied = merges.flatMap((merge) => merge?.applied ?? []);
    const conflicts = merges.flatMap((merge) => (merge?.conflicts ?? []).map((conflict) => conflict.file));
    const check = applied.length > 0 && !signal.aborted ? await this.checkMain(wave, signal) : null;
    this.trace.recordWave({ wave, agents: ready.map((item) => item.agentId), applied, conflicts, check: check?.passed ?? null });
    const lastWorker = ready.findLast((item) => item.role === "worker");
    if (check && lastWorker) lastWorker.result += `\n${check.text}`;
  }

  async launch(item, signal, maxUsd = getRole(item.role).maxUsd) {
    this.agentCount++;
    item.agentId = `${item.role}-${this.agentCount}`;
    let workspace = null;
    try {
      if (item.role === "worker") workspace = createWorkspace({ root: PROJECT_ROOT, runId: this.runId, agentId: item.agentId });
      const root = workspace ? workspace.dir : PROJECT_ROOT;
      const run = await this.runAgent({ item, root, trace: this.trace, signal, planItems: this.loop.plan.items, maxUsd });
      return { ...run, workspace };
    } catch (error) {
      return { outcome: "error", summary: `Error: ${error.message}`, stats: createTurnStats(), workspace };
    }
  }

  finishItem(item, run, signal) {
    const workspace = run.workspace;
    const changes = workspace ? changedFiles(workspace) : [];
    const merge = workspace && !signal.aborted ? mergeWorkspace(workspace, PROJECT_ROOT) : null;
    if (workspace) removeWorkspace(workspace);
    item.result = formatResult(item, run, changes, merge);
    this.finished.set(item.agentId, item.result);
    if (item.id) this.finished.set(item.id, item.result);
    return merge;
  }

  async checkMain(wave, signal) {
    this.loop.takeCheckpoint(`wave ${wave} merged`);
    const command = findTestCommand(PROJECT_ROOT);
    const check = command ? await runDoneCheck(command, signal, PROJECT_ROOT) : null;
    if (this.loop.plan.hasOpenChecks()) await this.loop.plan.runOpenChecks(signal);
    return { passed: check?.passed ?? null, text: describeCheck(check, command) };
  }

  async runBestOf(task, size, signal) {
    this.loop.openCheckpoints();
    const tournament = await runTournament(this, { task, size, lessons: [], maxUsd: this.settings.workerMaxUsd }, signal);
    return { ...tournament.stats, outcome: tournament.passed ? "done" : "tests_failing" };
  }

  async runFallbackTournament(task, lessons, signal) {
    const size = this.settings.tournamentSize;
    const remaining = CONFIG.maxSessionUsd - this.trace.totals.cost;
    if (!this.settings.autoTournament || size < 1 || remaining <= 0) return false;
    const maxUsd = Math.min(this.settings.workerMaxUsd, remaining / size);
    const tournament = await runTournament(this, { task, size, lessons, maxUsd }, signal);
    return tournament.passed;
  }
}
