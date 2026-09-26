import fs from "node:fs";
import { readStateText, statePath } from "./state.js";

const LESSONS_FILE = "lessons.jsonl";
const GOAL_CHARS = 300;
const SHOWN_GOAL_CHARS = 100;
const FAILING_LINES = 15;
const SHOWN_FAILING_LINES = 8;
const MAX_ERRORS = 3;
const OUTCOME_HINTS = {
  max_turns: "It ran out of turns: read what you need in one go and make the edits in fewer steps.",
  stalled: "It stopped making progress: try a different hypothesis.",
  tests_failing: "Its changes did not make the tests pass: try a different fix.",
  gave_up: "It gave up.",
};

export function buildLesson({ task, attempt, outcome, diffStat, failingOutput, errors, editedFiles, toolCounts }) {
  return {
    time: new Date().toISOString(),
    goal: task.slice(0, GOAL_CHARS),
    attempt,
    outcome,
    diffStat: diffStat || "no file changes",
    failingTests: lastLines(failingOutput ?? "", FAILING_LINES),
    lastErrors: errors.slice(-MAX_ERRORS),
    approaches: { filesEdited: [...editedFiles], tools: Object.fromEntries(toolCounts) },
  };
}

export function appendLesson(lesson) {
  fs.appendFileSync(statePath(LESSONS_FILE), `${JSON.stringify(lesson)}\n`);
}

export function readRecentLessons(count) {
  if (count <= 0) return [];
  const lessons = [];
  for (const line of readStateText(LESSONS_FILE).split("\n")) {
    const lesson = parseLine(line);
    if (lesson) lessons.push(lesson);
  }
  return lessons.slice(-count);
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function buildFreshAttemptMessage(task, lessons) {
  const intro = "Earlier attempts at this task failed and their changes were undone. Do not repeat what failed:";
  return `${task}\n\n# Lessons from earlier attempts\n${intro}\n${formatLessons(lessons, false)}`;
}

export function formatLessons(lessons, withGoal) {
  return lessons.map((lesson) => formatLesson(lesson, withGoal)).join("\n");
}

function formatLesson(lesson, withGoal) {
  const lines = [`- Attempt ${lesson.attempt} ended ${lesson.outcome}. ${OUTCOME_HINTS[lesson.outcome] ?? ""}`.trimEnd()];
  if (withGoal) lines.push(`  Goal: ${oneLine(lesson.goal).slice(0, SHOWN_GOAL_CHARS)}`);
  lines.push(`  Changes: ${lesson.diffStat}`);
  lines.push(`  Approach: edited ${lesson.approaches.filesEdited.join(", ") || "no files"}; tools ${describeToolCounts(lesson.approaches.tools)}`);
  if (lesson.lastErrors.length > 0) lines.push(`  Tool errors: ${lesson.lastErrors.join(" | ")}`);
  if (lesson.failingTests) lines.push(`  Failing output:\n${indent(lastLines(lesson.failingTests, SHOWN_FAILING_LINES))}`);
  return lines.join("\n");
}

function describeToolCounts(tools) {
  const parts = Object.entries(tools).map(([name, count]) => `${name}×${count}`);
  return parts.join(", ") || "none";
}

function oneLine(text) {
  return text.replaceAll("\n", " ").trim();
}

function indent(text) {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

function lastLines(text, count) {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
