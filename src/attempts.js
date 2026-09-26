import { CONFIG } from "./config.js";
import { Plan } from "./plan.js";
import { Checkpoints } from "./checkpoints.js";
import { StallWatch } from "./progress.js";
import { AttemptRecord } from "./attemptrecord.js";
import { findTestCommand, runDoneCheck } from "./checks.js";
import { runAttemptTurns } from "./turns.js";
import { appendLesson, buildFreshAttemptMessage, buildLesson, readRecentLessons } from "./lessons.js";
import { buildResumeMessage, saveLoopState } from "./session.js";
import { writeDimLine } from "./ui.js";

const LOOP = CONFIG.loop;
const RETRY_OUTCOMES = new Set(["tests_failing", "stalled", "max_turns"]);
const LESSON_OUTCOMES = new Set([...RETRY_OUTCOMES, "gave_up"]);
const MEASURED_OUTCOMES = new Set(["stalled", "max_turns", "gave_up"]);

export class TaskLoop {
  constructor(agent) {
    this.agent = agent;
    this.trace = agent.trace;
    this.plan = new Plan();
    this.checkpoints = new Checkpoints();
    this.stall = new StallWatch({ noteTurns: LOOP.stallNoteTurns, endTurns: LOOP.stallEndTurns });
    this.sessionStart = null;
    this.attempt = null;
    this.compactedItems = new Set();
  }

  async runTask(task, signal) {
    this.openCheckpoints();
    this.beginTask(task, { best: null, realAttempts: 0 });
    this.startAttempt(1, null);
    return this.runAttempts(signal);
  }

  async resume(saved, signal) {
    this.checkpoints.open();
    this.sessionStart = saved.checkpoints.sessionStart;
    this.checkpoints.adopt([saved.checkpoints.sessionStart, saved.checkpoints.attemptStart]);
    this.checkpoints.restore(saved.checkpoints.last);
    this.plan.restore(saved.plan);
    this.plan.takeChange();
    this.beginTask(saved.task, saved);
    this.taskLessons = readRecentLessons(saved.lessons);
    this.startAttempt(saved.attempt, saved.checkpoints.attemptStart, saved.planAtStart);
    this.trace.recordResume({ attempt: saved.attempt, checkpoint: saved.checkpoints.last, doneItems: this.plan.countDone() });
    writeDimLine(`Resuming attempt ${saved.attempt} from checkpoint ${saved.checkpoints.last.slice(0, 10)}\n${this.plan.render()}`);
    this.agent.startConversation(buildResumeMessage(saved.task, this.plan.render()));
    return this.runAttempts(signal);
  }

  beginTask(task, { best, realAttempts }) {
    this.task = task;
    this.best = best;
    this.realAttempts = realAttempts;
    this.taskLessons = [];
  }

  openCheckpoints() {
    if (!this.checkpoints.open() || this.sessionStart) return;
    this.sessionStart = this.takeCheckpoint("session start") ?? this.checkpoints.latest();
  }

  async runAttempts(signal) {
    const stats = { cost: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 };
    while (true) {
      const turnsOutcome = await runAttemptTurns(this.agent, this, signal, stats);
      const outcome = await this.measureTests(turnsOutcome, signal);
      this.endAttempt(outcome);
      const canRetry = RETRY_OUTCOMES.has(outcome) && this.attempt.number < LOOP.maxAttempts;
      if (!canRetry) return { ...stats, outcome: this.finishTask(outcome) };
      this.startFreshAttempt();
    }
  }

  startAttempt(number, startRef, planAtStart = this.plan.toJSON()) {
    const ref = startRef ?? this.takeCheckpoint(`attempt ${number} start`) ?? this.checkpoints.latest();
    this.attempt = new AttemptRecord(number, ref, planAtStart);
    this.stall.reset();
    this.giveUpReason = null;
    this.trace.recordAttemptStart({ attempt: number, checkpoint: ref, resumed: startRef !== null });
    this.saveState("running");
  }

  startFreshAttempt() {
    const previous = this.attempt;
    this.checkpoints.restore(previous.startRef);
    this.plan.restore(previous.planAtStart);
    this.plan.takeChange();
    writeDimLine(`[attempt ${previous.number} ended ${previous.outcome}; files restored; starting attempt ${previous.number + 1} with its lesson]`);
    this.startAttempt(previous.number + 1, null);
    this.agent.startConversation(buildFreshAttemptMessage(this.task, this.taskLessons));
  }

  async measureTests(outcome, signal) {
    if (!MEASURED_OUTCOMES.has(outcome) || !this.agent.doneCheckEnabled) return outcome;
    const testCommand = findTestCommand();
    if (!testCommand) return outcome;
    const check = await runDoneCheck(testCommand, signal);
    this.attempt.noteCheck(check.passed, check.tail);
    if (!check.passed || outcome === "gave_up" || this.plan.hasOpenItems()) return outcome;
    writeDimLine(`[attempt ${this.attempt.number} ended ${outcome}, but the tests pass and no plan item is open, so it counts as done]`);
    return "done";
  }

  endAttempt(outcome) {
    const attempt = this.attempt;
    attempt.outcome = outcome;
    const endRef = this.takeCheckpoint(`attempt ${attempt.number} end`) ?? this.checkpoints.latest();
    const score = attempt.score(this.plan.countDone());
    if (!this.best || score > this.best.score) this.best = { attempt: attempt.number, score, ref: endRef };
    if (attempt.isReal()) this.realAttempts++;
    this.trace.recordAttemptEnd({ attempt: attempt.number, outcome, score, turns: attempt.turns, toolCalls: attempt.toolCalls });
    if (LESSON_OUTCOMES.has(outcome)) this.writeLesson(attempt, endRef);
  }

  writeLesson(attempt, endRef) {
    const lesson = buildLesson({
      task: this.task,
      attempt: attempt.number,
      outcome: attempt.outcome,
      diffStat: this.checkpoints.diffStat(attempt.startRef, endRef),
      failingOutput: attempt.lastFailure,
      errors: attempt.errors,
      editedFiles: attempt.editedFiles,
      toolCounts: attempt.toolCounts,
    });
    appendLesson(lesson);
    this.taskLessons.push(lesson);
    this.trace.recordLesson({ attempt: attempt.number, outcome: attempt.outcome, diffStat: lesson.diffStat });
  }

  finishTask(outcome) {
    const restoreBest = outcome !== "done" && this.best?.ref && this.best.ref !== this.checkpoints.latest();
    if (restoreBest) {
      this.checkpoints.restore(this.best.ref);
      writeDimLine(`[restored the files of attempt ${this.best.attempt}, the best attempt]`);
    }
    this.saveState(outcome);
    return outcome;
  }

  takeCheckpoint(label) {
    const ref = this.checkpoints.take(label);
    if (ref) this.trace.recordCheckpoint({ label, ref });
    return ref;
  }

  saveState(status) {
    saveLoopState(this, status);
  }
}
