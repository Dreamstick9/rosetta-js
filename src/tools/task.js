import path from "node:path";
import { CONFIG } from "../config.js";
import { describeToolRefusal } from "../roles.js";

const TASK_ROLES = ["explorer", "worker", "reviewer"];

export const taskTool = {
  definition: {
    type: "function",
    function: {
      name: "task",
      description: "Hand a sub-task to a sub-agent that starts with a fresh, small context. explorer: reads the code and reports (cheap, read-only; several run in parallel). worker: changes code in a private copy that is merged back file by file. All task calls of one reply run together; the harness orders them by depends_on and by overlapping files. The result is the sub-agent's short report.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: TASK_ROLES, description: "explorer, worker or reviewer." },
          prompt: { type: "string", description: "The sub-task, with everything the sub-agent needs to know." },
          files: { type: "array", items: { type: "string" }, description: "Files the sub-task reads or changes, relative to the project root." },
          depends_on: { type: "array", items: { type: "string" }, description: "ids of tasks that must finish and merge first." },
          id: { type: "string", description: "A short id other tasks can name in depends_on." },
        },
        required: ["role", "prompt"],
      },
    },
  },
  run: () => {
    throw new Error("task calls run through the orchestrator");
  },
};

export async function runTaskCalls(calls, context) {
  const startedAt = Date.now();
  const requests = calls.map((call) => readRequest(call, context));
  const valid = requests.filter((request) => !request.error);
  const outputs = valid.length > 0 ? await context.orchestrator.runTasks(valid, context.signal) : [];
  const ms = Date.now() - startedAt;
  return calls.map((call, index) => {
    const request = requests[index];
    if (request.error) return { call, output: `Error: ${request.error}`, status: "error", ms };
    return { call, output: outputs[valid.indexOf(request)], status: "ok", ms };
  });
}

function readRequest(call, context) {
  try {
    return { ...parseRequest(call, context), error: null };
  } catch (error) {
    return { error: error.message };
  }
}

function parseRequest(call, context) {
  if (call.argumentsError) throw new Error(call.argumentsError);
  const refusal = describeToolRefusal(context.role, "task");
  if (refusal) throw new Error(refusal);
  if (!context.orchestrator) throw new Error("sub-agents are not available here");
  const args = call.args ?? {};
  if (!TASK_ROLES.includes(args.role)) throw new Error(`role must be one of ${TASK_ROLES.join(", ")}`);
  if (args.role === "reviewer" && !CONFIG.agents.reviewerEnabled) throw new Error("the reviewer role is turned off (agents.reviewerEnabled)");
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt must be a non-empty string");
  return {
    role: args.role,
    prompt: args.prompt.trim(),
    files: readList(args.files, "files").map((file) => path.normalize(file)),
    dependsOn: readList(args.depends_on, "depends_on"),
    id: typeof args.id === "string" && args.id.trim() ? args.id.trim() : null,
  };
}

function readList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name} must be a list of strings`);
  return value.map((entry) => entry.trim()).filter(Boolean);
}
