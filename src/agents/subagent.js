import { CONFIG } from "../config.js";
import { Agent } from "../agent.js";
import { AttemptRecord } from "../attemptrecord.js";
import { Plan } from "../plan.js";
import { StallWatch } from "../progress.js";
import { getRole } from "../roles.js";
import { createTurnStats, runAttemptTurns } from "../turns.js";
import { createShellSession, stopShellSession } from "../tools/shell.js";
import { buildBriefing, buildSystemMessage } from "./briefing.js";

const NO_STALL_LIMIT = Infinity;

class SubtaskLoop {
  constructor(agent, root, readOnly) {
    this.trace = agent.trace;
    this.plan = new Plan();
    this.checkpoints = { enabled: false };
    this.attempt = new AttemptRecord(1, null, null, root);
    this.compactedItems = new Set();
    this.giveUpReason = null;
    const limits = readOnly ? { noteTurns: NO_STALL_LIMIT, endTurns: NO_STALL_LIMIT } : { noteTurns: CONFIG.loop.stallNoteTurns, endTurns: CONFIG.loop.stallEndTurns };
    this.stall = new StallWatch(limits);
  }

  takeCheckpoint() {
    return null;
  }

  saveState() {}
}

export async function runSubagent({ item, root, trace, signal, planItems, maxUsd }) {
  const role = getRole(item.role);
  const shell = createShellSession(root);
  const scope = { id: item.agentId, role: role.name, root, shell, maxUsd, quiet: true };
  const agentTrace = trace.forAgent(item.agentId, role.name);
  const agent = new Agent({ config: { ...CONFIG, maxTurns: role.maxTurns }, trace: agentTrace, scope });
  agent.loop = new SubtaskLoop(agent, root, role.readOnly);
  agent.doneCheckEnabled = false;
  agent.startSubtask(buildSystemMessage(role.name), buildBriefing({ item, root, planItems }));
  agentTrace.recordAgentStart({ root, files: item.files, dependsOn: item.dependsOn });
  const stats = createTurnStats();
  const run = await playSubtask(agent, signal, stats);
  stopShellSession(shell);
  agentTrace.recordAgentEnd({ outcome: run.outcome, ...stats });
  return { ...run, stats };
}

async function playSubtask(agent, signal, stats) {
  try {
    const outcome = await runAttemptTurns(agent, agent.loop, signal, stats);
    return { outcome, summary: findLastReply(agent.messages) };
  } catch (error) {
    if (signal.aborted) return { outcome: "interrupted", summary: "Interrupted by the user." };
    return { outcome: "error", summary: `Error: ${error.message}` };
  }
}

function findLastReply(messages) {
  const replies = messages.filter((message) => message.role === "assistant" && message.content.trim());
  if (replies.length === 0) return "(no final reply)";
  return replies.at(-1).content.trim();
}
