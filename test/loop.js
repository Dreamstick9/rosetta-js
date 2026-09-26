import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setProjectRoot } from "../src/config.js";
import { Plan } from "../src/plan.js";
import { Checkpoints } from "../src/checkpoints.js";
import { StallWatch } from "../src/progress.js";
import { appendLesson, buildLesson, formatLessons, readRecentLessons } from "../src/lessons.js";

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

async function main() {
  const folder = createRepository();
  setProjectRoot(folder);
  const gitBefore = hashGitFolder(folder);
  await checkPlan(folder);
  checkCheckpoints(folder);
  checkStallWatch();
  checkLessons();
  expect(hashGitFolder(folder) === gitBefore, "the repository's own .git folder changed");
  const exclude = fs.readFileSync(path.join(folder, ".git/info/exclude"), "utf8");
  expect(exclude.split("\n").includes(".rosetta/"), ".rosetta/ was not added to .git/info/exclude");
  expect(runGit(folder, ["status", "--porcelain"]).includes(".rosetta") === false, "git status shows .rosetta");
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL loop: ${failure}`);
    console.error(`The test folder is kept in ${folder}.`);
    process.exit(1);
  }
  fs.rmSync(folder, { recursive: true, force: true });
  console.log("PASS loop: plan ticks, checkpoints and undo, stall counters and lessons.");
}

function createRepository() {
  const folder = fs.mkdtempSync("/tmp/rjs-loop-");
  fs.writeFileSync(path.join(folder, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(folder, "main.js"), "export const value = 1;\n");
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "initial"]]) runGit(folder, args);
  return folder;
}

function runGit(folder, args) {
  const result = spawnSync("git", args, { cwd: folder, encoding: "utf8", env: { ...process.env, ...GIT_IDENTITY } });
  return result.stdout;
}

function hashGitFolder(folder) {
  const hash = createHash("sha256");
  const pending = [path.join(folder, ".git")];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (full.endsWith(path.join("info", "exclude"))) continue;
      hash.update(full);
      if (entry.isDirectory()) pending.push(full);
      else hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest("hex");
}

async function checkPlan(folder) {
  const plan = new Plan();
  const signal = new AbortController().signal;
  plan.setItems([{ text: "create a", check: "test -f a.txt" }, { text: "create b", check: "test -f b.txt" }, { text: "write notes" }]);
  await plan.runOpenChecks(signal);
  expect(plan.countDone() === 0, "a plan item was ticked before its check passed");
  fs.writeFileSync(path.join(folder, "a.txt"), "a\n");
  await plan.runOpenChecks(signal);
  const ticks = plan.takeNewTicks();
  expect(ticks.length === 1 && ticks[0].id === 1, "the passing check did not tick item 1");
  expect(throws(() => plan.setStatus(2, "done")), "the model could finish a checked item without its check");
  plan.setStatus(3, "done");
  const rendered = plan.render();
  expect(rendered.includes("☑ 1. create a") && rendered.includes("☐ 2. create b") && rendered.includes("☑ 3. write notes"), `unexpected render:\n${rendered}`);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, ".rosetta/plan.json"), "utf8"));
  expect(saved.items[0].status === "done", "plan.json was not saved after the tick");
  fs.rmSync(path.join(folder, "a.txt"));
}

function throws(action) {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

function checkCheckpoints(folder) {
  const checkpoints = new Checkpoints();
  expect(checkpoints.open(), "checkpoints did not open");
  const start = checkpoints.take("start");
  fs.writeFileSync(path.join(folder, "main.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(folder, "added.js"), "export const added = true;\n");
  fs.writeFileSync(path.join(folder, "ignored.txt"), "keep me\n");
  const second = checkpoints.take("second");
  expect(start && second && start !== second, "a changed tree did not create a new checkpoint");
  expect(checkpoints.take("same") === null, "an unchanged tree created a checkpoint");
  fs.writeFileSync(path.join(folder, "later.js"), "later\n");
  expect(checkpoints.undo() === second, "undo did not go back to the previous checkpoint");
  expect(!fs.existsSync(path.join(folder, "later.js")), "undo left a file added after the checkpoint");
  expect(checkpoints.describeDiff(start, 50).stat.includes("added.js"), "diff since start does not list added.js");
  expect(checkpoints.undo() === start, "the second undo did not reach the start checkpoint");
  expect(!fs.existsSync(path.join(folder, "added.js")), "undo left added.js");
  expect(fs.readFileSync(path.join(folder, "main.js"), "utf8").includes("value = 1"), "undo did not restore main.js");
  expect(fs.existsSync(path.join(folder, "ignored.txt")), "undo removed a file ignored by .gitignore");
  expect(checkpoints.describeDiff(start, 50).stat === "(no changes)", "diff after undo is not empty");
}

function checkStallWatch() {
  const watch = new StallWatch({ noteTurns: 2, endTurns: 4 });
  const quiet = [watch.endTurn(), watch.endTurn(), watch.endTurn()];
  expect(quiet.join(",") === ",note,", `unexpected stall actions ${quiet.join(",")}`);
  watch.noteFileChange();
  expect(watch.endTurn() === null && watch.quietTurns === 0, "a first file change did not count as progress");
  watch.noteFileChange();
  watch.noteCheck(false, "FAIL a\nFAIL b\nFAIL c");
  watch.endTurn();
  expect(watch.quietTurns === 1, "a repeated file change or the first failing check counted as progress");
  watch.noteCheck(false, "FAIL a");
  expect(watch.endTurn() === null && watch.quietTurns === 0, "fewer failing lines did not count as progress");
  watch.endTurn();
  watch.endTurn();
  watch.endTurn();
  expect(watch.endTurn() === "end", "four quiet turns did not end the attempt");
}

function checkLessons() {
  const lesson = buildLesson({
    task: "x".repeat(500),
    attempt: 1,
    outcome: "stalled",
    diffStat: " 1 file changed, 2 insertions(+)",
    failingOutput: "line\nAssertionError: 4 !== 5",
    errors: ["edit_file: old_text not found"],
    editedFiles: new Set(["math.js"]),
    toolCounts: new Map([["bash", 2], ["edit_file", 1]]),
  });
  appendLesson(lesson);
  const lessons = readRecentLessons(5);
  expect(lessons.length === 1 && lessons[0].goal.length === 300, "the lesson was not written with a 300-char goal");
  const text = formatLessons(lessons, false);
  expect(text.includes("Attempt 1 ended stalled") && text.includes("bash×2") && text.includes("AssertionError"), `unexpected lesson text:\n${text}`);
}

main();
