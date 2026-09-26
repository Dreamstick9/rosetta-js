const ACTIONS = ["set", "start", "done", "fail", "show"];
const STATUS_BY_ACTION = { start: "active", fail: "failed" };

export const todoTool = {
  definition: {
    type: "function",
    function: {
      name: "todo",
      description: "Keep a plan for a multi-step task. set replaces the plan with items; give each item a check (a shell command that exits 0 once the item is finished, e.g. its test) when possible. The harness runs the checks after your changes and ticks passing items itself; an item with a check can only be finished by its check passing. start/done/fail take an item id; show returns the plan.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ACTIONS, description: "What to do." },
          items: {
            type: "array",
            description: "For set: the plan items in order.",
            items: {
              type: "object",
              properties: { text: { type: "string" }, check: { type: "string", description: "Optional shell command that passes when the item is finished." } },
              required: ["text"],
            },
          },
          id: { type: "integer", description: "For start, done and fail: the item id." },
        },
        required: ["action"],
      },
    },
  },
  run: runTodo,
};

async function runTodo({ action, items, id }, { signal, loop }) {
  const plan = loop.plan;
  if (!ACTIONS.includes(action)) throw new Error(`unknown action '${action}'. Use one of: ${ACTIONS.join(", ")}`);
  if (action === "set") plan.setItems(items);
  if (action === "done") return finishItem(plan, plan.findItem(id), signal);
  if (STATUS_BY_ACTION[action]) plan.setStatus(id, STATUS_BY_ACTION[action]);
  return plan.render();
}

async function finishItem(plan, item, signal) {
  if (!item.check) {
    plan.setStatus(item.id, "done");
    return plan.render();
  }
  if (item.status === "done") return plan.render();
  const result = await plan.runItemCheck(item, signal);
  if (result.passed) return `Check passed; item ${item.id} is done.\n${plan.render()}`;
  return `Check \`${item.check}\` failed, so item ${item.id} stays open. Last lines of output:\n${result.tail}\n\n${plan.render()}`;
}
