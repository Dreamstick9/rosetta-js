import { CONFIG } from "./config.js";
import { runCheckCommand } from "./checks.js";
import { writeStateJson } from "./state.js";

const CHECK_TIMEOUT_MS = CONFIG.loop.checkTimeoutSeconds * 1000;
const PLAN_FILE = "plan.json";
const STATUS_MARKS = { pending: "☐", active: "◐", done: "☑", failed: "✗" };

export class Plan {
  constructor() {
    this.items = [];
    this.newTicks = [];
    this.changed = false;
  }

  setItems(list) {
    if (!Array.isArray(list) || list.length === 0) throw new Error("set needs a non-empty items list");
    this.items = list.map((item, index) => createItem(item, index + 1));
    this.markChanged();
  }

  findItem(id) {
    const item = this.items.find((candidate) => candidate.id === Number(id));
    if (!item) throw new Error(`there is no plan item ${id}. ${this.render()}`);
    return item;
  }

  setStatus(id, status) {
    const item = this.findItem(id);
    if (status === "done" && item.check) throw new Error(`item ${item.id} has a check; only a passing check can finish it`);
    item.status = status;
    this.markChanged();
  }

  tick(item) {
    item.status = "done";
    this.newTicks.push(item);
    this.markChanged();
  }

  async runItemCheck(item, signal) {
    const result = await runCheckCommand(item.check, signal, CHECK_TIMEOUT_MS);
    signal.throwIfAborted();
    if (result.passed) this.tick(item);
    return result;
  }

  async runOpenChecks(signal) {
    const failures = [];
    for (const item of this.items) {
      if (item.status === "done" || !item.check) continue;
      const result = await this.runItemCheck(item, signal);
      if (!result.passed) failures.push(result.tail);
    }
    return failures;
  }

  hasOpenChecks() {
    return this.items.some((item) => item.status !== "done" && item.check);
  }

  hasOpenItems() {
    return this.items.some((item) => item.status !== "done");
  }

  countDone() {
    return this.items.filter((item) => item.status === "done").length;
  }

  takeNewTicks() {
    const ticks = this.newTicks;
    this.newTicks = [];
    return ticks;
  }

  takeChange() {
    const changed = this.changed;
    this.changed = false;
    return changed;
  }

  render() {
    if (this.items.length === 0) return "Plan: (empty)";
    const lines = this.items.map(renderItem);
    return `Plan:\n${lines.join("\n")}`;
  }

  toJSON() {
    return { items: this.items.map((item) => ({ ...item })) };
  }

  restore(saved) {
    this.items = (saved?.items ?? []).map((item) => ({ ...item }));
    this.newTicks = [];
    this.markChanged();
  }

  markChanged() {
    this.changed = true;
    writeStateJson(PLAN_FILE, this.toJSON());
  }
}

function createItem(item, id) {
  const text = typeof item === "string" ? item : item?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error(`plan item ${id} needs a text`);
  const check = typeof item?.check === "string" && item.check.trim() ? item.check.trim() : null;
  return { id, text: text.trim(), check, status: "pending" };
}

function renderItem(item) {
  const check = item.check ? `  (check: ${item.check})` : "";
  return `${STATUS_MARKS[item.status]} ${item.id}. ${item.text}${check}`;
}
