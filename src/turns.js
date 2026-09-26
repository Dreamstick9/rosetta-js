import { CONFIG } from "./config.js";
import { findTestCommand, runDoneCheck, snapshotsDiffer, takeProjectSnapshot } from "./checks.js";
import { writeDimLine, writeError } from "./ui.js";

const MAX_NUDGES = CONFIG.agent.maxEmptyReplyNudges;
const MAX_CHECK_ROUNDS = CONFIG.agent.maxCheckRounds;
const MILESTONE_COMPACT_SHARE = CONFIG.loop.milestoneCompactShare;
const NUDGE_MESSAGE = "Please continue.";
const STALL_NOTE = "You have made no progress for several turns: no plan item was ticked and the tests are not closer to passing. Stop and state a new hypothesis about the cause, then try a different approach.";

export async function runAttemptTurns(agent, loop, signal, stats) {
  const attempt = loop.attempt;
  for (let turn = 1; turn <= agent.config.maxTurns; turn++) {
    stats.turns++;
    attempt.turns++;
    if (agent.trace.totals.cost >= agent.config.maxSessionUsd) return stopForBudget(agent.config);
    const reply = await agent.requestReply(signal, stats);
    const outcome = await playTurn(agent, loop, reply, signal);
    if (outcome) return outcome;
    const stall = loop.stall.endTurn();
    if (!stall) continue;
    recordStall(agent, loop, stall);
    if (stall === "end") return "stalled";
    agent.addUserMessage(STALL_NOTE);
  }
  writeError(`Stopped: attempt ${attempt.number} reached maxTurns (${agent.config.maxTurns} model calls).`);
  return "max_turns";
}

function recordStall(agent, loop, action) {
  const quietTurns = loop.stall.quietTurns;
  agent.trace.recordStall({ attempt: loop.attempt.number, quietTurns, action });
  writeDimLine(`[no progress for ${quietTurns} turns${action === "end" ? "; ending this attempt" : ""}]`);
}

function stopForBudget(config) {
  writeError(`Stopped: the session cost reached maxSessionUsd ($${config.maxSessionUsd}).`);
  return "budget";
}

async function playTurn(agent, loop, reply, signal) {
  if (reply.toolCalls.length === 0) return finishReply(agent, loop, reply, signal);
  const results = await agent.runTools(reply.toolCalls, signal);
  for (const result of results) loop.attempt.noteToolResult(result);
  if (loop.giveUpReason) return "gave_up";
  await afterToolTurn(agent, loop, signal);
  return null;
}

async function afterToolTurn(agent, loop, signal) {
  const attempt = loop.attempt;
  const plan = loop.plan;
  const changed = attempt.takeTurnChange() && hasNewCheckpoint(loop, `attempt ${attempt.number} turn ${attempt.turns}`);
  if (changed) loop.stall.noteFileChange();
  if (changed && plan.hasOpenChecks()) {
    const failures = await plan.runOpenChecks(signal);
    if (failures.length > 0) attempt.lastFailure = failures.at(-1);
  }
  const ticks = plan.takeNewTicks();
  if (plan.takeChange()) writeDimLine(plan.render());
  if (ticks.length > 0) recordTicks(agent, loop, ticks);
  if (changed || ticks.length > 0) loop.saveState("running");
}

function hasNewCheckpoint(loop, label) {
  if (!loop.checkpoints.enabled) return true;
  return loop.takeCheckpoint(label) !== null;
}

function recordTicks(agent, loop, ticks) {
  for (const item of ticks) {
    agent.trace.recordTick({ attempt: loop.attempt.number, id: item.id, text: item.text, check: item.check });
    loop.stall.noteTick();
  }
  loop.takeCheckpoint(`tick ${ticks.map((item) => item.id).join(",")}`);
  compactAtMilestone(agent, loop, ticks);
}

function compactAtMilestone(agent, loop, ticks) {
  const newItems = ticks.filter((item) => !loop.compactedItems.has(item.id));
  if (newItems.length === 0) return;
  if (agent.estimateContextTokens() <= agent.config.maxContextTokens * MILESTONE_COMPACT_SHARE) return;
  for (const item of newItems) loop.compactedItems.add(item.id);
  agent.compact(true);
}

async function finishReply(agent, loop, reply, signal) {
  const attempt = loop.attempt;
  const followUp = reply.content.trim() ? await checkWork(agent, loop, signal) : nudge(attempt);
  if (!followUp) return attempt.outcome;
  agent.addUserMessage(followUp);
  return null;
}

function nudge(attempt) {
  if (attempt.nudges >= MAX_NUDGES) {
    writeError("The model returned an empty reply.");
    attempt.outcome = "empty_reply";
    return null;
  }
  attempt.nudges++;
  writeDimLine("[empty reply; asking the model to continue]");
  return NUDGE_MESSAGE;
}

async function checkWork(agent, loop, signal) {
  const attempt = loop.attempt;
  if (!agent.doneCheckEnabled || !attempt.takeCheckChange()) return null;
  const snapshot = takeProjectSnapshot();
  const filesChanged = snapshotsDiffer(attempt.snapshot, snapshot);
  attempt.snapshot = snapshot;
  if (!filesChanged) return null;
  const testCommand = findTestCommand();
  if (!testCommand) return null;
  const check = await runDoneCheck(testCommand, signal);
  attempt.noteCheck(check.passed, check.tail);
  loop.stall.noteCheck(check.passed, check.tail);
  if (check.passed) return null;
  if (attempt.checkRounds >= MAX_CHECK_ROUNDS) {
    attempt.outcome = "tests_failing";
    return null;
  }
  attempt.checkRounds++;
  return check.failureMessage;
}
