import { CONFIG } from "../config.js";

const MIN_ATTEMPTS = CONFIG.loop.giveUpMinAttempts;

export const giveUpTool = {
  definition: {
    type: "function",
    function: {
      name: "give_up",
      description: "Stop working on the task because it cannot be done (for example, requirements or tests that contradict each other). Explain why in reason. Only accepted after real attempts were made.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why the task cannot be done." } },
        required: ["reason"],
      },
    },
  },
  run: giveUp,
};

async function giveUp({ reason }, { loop }) {
  const realAttempts = loop.realAttempts + (loop.attempt.isReal() ? 1 : 0);
  const accepted = realAttempts >= MIN_ATTEMPTS;
  loop.trace.recordGiveUp({ attempt: loop.attempt.number, reason: reason.trim(), accepted });
  if (!accepted) {
    throw new Error(`give_up refused for now: it is accepted after ${MIN_ATTEMPTS} real attempts and ${realAttempts} were made so far. Check your reasoning another way before giving up again; never special-case or game the tests.`);
  }
  loop.giveUpReason = reason.trim();
  return "Accepted. The task ends here; the best attempt's files are restored.";
}
