import { takeProjectSnapshot } from "./checks.js";
import { countFailureLines } from "./progress.js";

const EDIT_TOOLS = new Set(["create_file", "write_file", "edit_file", "delete_file"]);
const CHANGING_TOOLS = new Set([...EDIT_TOOLS, "bash", "task"]);
const KEPT_ERRORS = 5;
const ERROR_LENGTH = 160;
const CHECK_PASSED_POINTS = 1_000_000;
const TICK_POINTS = 1000;
const MAX_FAILURE_PENALTY = 999;

export class AttemptRecord {
  constructor(number, startRef, planAtStart, root = undefined) {
    this.number = number;
    this.startRef = startRef;
    this.planAtStart = planAtStart;
    this.turns = 0;
    this.toolCalls = 0;
    this.toolCounts = new Map();
    this.errors = [];
    this.editedFiles = new Set();
    this.changedThisTurn = false;
    this.changedSinceCheck = false;
    this.nudges = 0;
    this.checkRounds = 0;
    this.outcome = "done";
    this.checkPassed = false;
    this.lastFailure = "";
    this.snapshot = takeProjectSnapshot(root);
  }

  noteToolResult({ call, output, status }) {
    this.toolCalls++;
    this.toolCounts.set(call.name, (this.toolCounts.get(call.name) ?? 0) + 1);
    if (status !== "ok") {
      this.errors.push(`${call.name}: ${output.split("\n")[0].slice(0, ERROR_LENGTH)}`);
      this.errors = this.errors.slice(-KEPT_ERRORS);
      return;
    }
    if (EDIT_TOOLS.has(call.name)) this.editedFiles.add(call.args.path);
    if (!CHANGING_TOOLS.has(call.name)) return;
    this.changedThisTurn = true;
    this.changedSinceCheck = true;
  }

  noteCheck(passed, output) {
    this.checkPassed = passed;
    if (!passed) this.lastFailure = output;
  }

  takeTurnChange() {
    const changed = this.changedThisTurn;
    this.changedThisTurn = false;
    return changed;
  }

  takeCheckChange() {
    const changed = this.changedSinceCheck;
    this.changedSinceCheck = false;
    return changed;
  }

  isReal() {
    return this.toolCalls > 0;
  }

  score(doneItems) {
    const checkPoints = this.checkPassed ? CHECK_PASSED_POINTS : 0;
    let failurePenalty = MAX_FAILURE_PENALTY;
    if (this.checkPassed) failurePenalty = 0;
    else if (this.lastFailure) failurePenalty = Math.min(countFailureLines(this.lastFailure), MAX_FAILURE_PENALTY);
    return checkPoints + doneItems * TICK_POINTS - failurePenalty;
  }
}
