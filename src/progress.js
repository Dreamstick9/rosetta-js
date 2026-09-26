const FAILURE_LINE_PATTERN = /\b(fail|failed|failing|failure|failures|error|errors|assert\w*|not ok)\b|✗|✖/i;

export class StallWatch {
  constructor({ noteTurns, endTurns }) {
    this.noteTurns = noteTurns;
    this.endTurns = endTurns;
    this.reset();
  }

  reset() {
    this.quietTurns = 0;
    this.noted = false;
    this.progressed = false;
    this.checkPassed = false;
    this.fewestFailures = null;
    this.changedFiles = false;
  }

  noteTick() {
    this.progressed = true;
  }

  noteFileChange() {
    if (this.changedFiles) return;
    this.changedFiles = true;
    this.progressed = true;
  }

  noteCheck(passed, output) {
    if (passed && !this.checkPassed) this.progressed = true;
    this.checkPassed = passed;
    if (passed) return;
    const failures = countFailureLines(output);
    if (this.fewestFailures !== null && failures < this.fewestFailures) this.progressed = true;
    if (this.fewestFailures === null || failures < this.fewestFailures) this.fewestFailures = failures;
  }

  endTurn() {
    if (this.progressed) {
      this.progressed = false;
      this.quietTurns = 0;
      this.noted = false;
      return null;
    }
    this.quietTurns++;
    if (this.quietTurns >= this.endTurns) return "end";
    if (this.quietTurns < this.noteTurns || this.noted) return null;
    this.noted = true;
    return "note";
  }
}

export function countFailureLines(output) {
  return output.split("\n").filter((line) => FAILURE_LINE_PATTERN.test(line)).length;
}
