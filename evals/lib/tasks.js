import fs from "node:fs";
import path from "node:path";

export const TASKS_DIR = new URL("../tasks/", import.meta.url).pathname;
const REQUIRED = ["id", "category", "repo", "commit", "task", "setup", "grade"];

export function loadTasks({ tasks: ids, quick }) {
  const all = fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith(".json")).sort().map(readTask);
  if (ids) return ids.map((id) => all.find((task) => task.id === id) ?? fail(`Unknown task ${id}`));
  if (quick) return all.filter((task) => task.quick);
  return all;
}

function readTask(name) {
  const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, name), "utf8"));
  for (const field of REQUIRED) if (task[field] === undefined) fail(`${name}: missing "${field}"`);
  return { ...task, dir: path.join(TASKS_DIR, task.id) };
}

function fail(message) {
  throw new Error(message);
}
