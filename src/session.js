import { readStateJson, writeStateJson } from "./state.js";

const SESSION_FILE = "session.json";

export function saveLoopState(loop, status) {
  writeStateJson(SESSION_FILE, {
    savedAt: new Date().toISOString(),
    status,
    task: loop.task,
    attempt: loop.attempt.number,
    realAttempts: loop.realAttempts,
    plan: loop.plan.toJSON(),
    planAtStart: loop.attempt.planAtStart,
    best: loop.best,
    checkpoints: { sessionStart: loop.sessionStart, attemptStart: loop.attempt.startRef, last: loop.checkpoints.latest() },
    lessons: loop.taskLessons.length,
  });
}

export function loadSession() {
  return readStateJson(SESSION_FILE);
}

export function describeUnresumable(saved) {
  if (!saved) return "there is no saved session in .rosetta/session.json";
  if (saved.status !== "running") return `the saved session already ended (${saved.status})`;
  if (!saved.checkpoints?.last) return "the saved session has no checkpoint to restore";
  return null;
}

export function buildResumeMessage(task, planText) {
  return [
    "We are resuming after an interruption. The files are back at the last checkpoint.",
    `Task:\n${task}`,
    planText,
    "Continue with the items that are not done yet; do not redo finished items.",
  ].join("\n\n");
}
