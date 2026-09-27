import path from "node:path";
import { findTestCommand, runDoneCheck } from "../checks.js";
import { countFailureLines } from "../progress.js";
import { createTurnStats } from "../turns.js";
import { writeLine } from "../ui.js";
import { countChangedLines } from "./filediff.js";
import { changedFiles, mergeWorkspace, removeWorkspace } from "./workspace.js";

export async function runTournament(orchestrator, { task, size, lessons, maxUsd }, signal) {
  const items = [];
  for (let index = 0; index < size; index++) items.push(createEntryItem(task, lessons));
  const runs = await runAll(orchestrator, items, maxUsd, signal);
  const scores = [];
  for (const [index, run] of runs.entries()) scores.push(await scoreRun(items[index], run, signal));
  const ranked = [...scores].sort(compareScores);
  const winner = ranked[0];
  const merged = winner.files > 0 && !signal.aborted ? mergeWinner(runs[scores.indexOf(winner)]) : [];
  for (const run of runs) if (run.workspace) removeWorkspace(run.workspace);
  if (merged.length > 0) orchestrator.loop.takeCheckpoint(`best of ${size}: ${winner.agent}`);
  orchestrator.trace.recordTournament({ scores, winner: winner.agent, merged });
  writeLine(describeScores(scores, winner, merged));
  return { passed: winner.passed && merged.length > 0, stats: sumStats(runs) };
}

function createEntryItem(task, lessons) {
  return { role: "worker", prompt: task, files: [], dependsOn: [], id: null, predecessors: [], earlierResults: [], lessons, agentId: null, result: null };
}

async function runAll(orchestrator, items, maxUsd, signal) {
  const cap = orchestrator.settings.maxParallelAgents;
  const runs = [];
  for (let start = 0; start < items.length; start += cap) {
    const batch = items.slice(start, start + cap);
    runs.push(...(await Promise.all(batch.map((item) => orchestrator.launch(item, signal, maxUsd)))));
  }
  return runs;
}

async function scoreRun(item, run, signal) {
  const score = { agent: item.agentId, outcome: run.outcome, passed: false, failingLines: 0, changedLines: 0, files: 0 };
  if (!run.workspace || signal.aborted) return score;
  const changes = changedFiles(run.workspace);
  score.files = changes.length;
  for (const { file } of changes) score.changedLines += countChangedLines(path.join(run.workspace.root, file), path.join(run.workspace.dir, file));
  const command = findTestCommand(run.workspace.dir);
  if (!command) return score;
  const check = await runDoneCheck(command, signal, run.workspace.dir);
  score.passed = check.passed;
  if (!check.passed) score.failingLines = countFailureLines(check.tail);
  return score;
}

function compareScores(first, second) {
  if (first.passed !== second.passed) return first.passed ? -1 : 1;
  if ((first.files === 0) !== (second.files === 0)) return first.files === 0 ? 1 : -1;
  if (first.failingLines !== second.failingLines) return first.failingLines - second.failingLines;
  return first.changedLines - second.changedLines;
}

function mergeWinner(run) {
  const merge = mergeWorkspace(run.workspace);
  return merge.applied;
}

function describeScores(scores, winner, merged) {
  const lines = [`Best of ${scores.length}: ${merged.length > 0 ? `merged ${winner.agent} (${merged.join(", ")})` : "nothing merged"}`];
  for (const score of scores) {
    const check = score.passed ? "check passed" : "check failed";
    const mark = score === winner ? "  ← winner" : "";
    lines.push(`  ${score.agent}: ${check} · ${score.failingLines} failing lines · ${score.changedLines} changed lines in ${score.files} files · ${score.outcome}${mark}`);
  }
  return lines.join("\n");
}

function sumStats(runs) {
  const total = createTurnStats();
  for (const run of runs) {
    for (const key of Object.keys(total)) total[key] += run.stats[key];
  }
  return total;
}
