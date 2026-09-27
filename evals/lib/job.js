import fs from "node:fs";
import path from "node:path";
import { copyHarness, runHarness } from "./harness.js";
import { applyPatch, grade } from "./grade.js";
import { prepareWorkspace } from "./workspace.js";
import { readTrace, summarizeTrace } from "./trace.js";

const DEFAULT_TIMEOUT_SECONDS = 900;

export async function runJob(job, context) {
  const { task, arm, run } = job;
  const name = `${task.id}.${arm.name}.${run}`;
  const workDir = path.join(context.workRoot, name);
  const logDir = path.join(context.logRoot, name);
  fs.mkdirSync(logDir, { recursive: true });
  const record = { task: task.id, category: task.category, arm: arm.name, run, logDir };
  try {
    await runSteps(job, context, { workDir, logDir, record });
  } catch (error) {
    record.passed = false;
    record.error = error.message.split("\n").slice(0, 8).join("\n");
  }
  if (!context.keep) fs.rmSync(workDir, { recursive: true, force: true });
  return record;
}

async function runSteps({ task, arm }, context, { workDir, logDir, record }) {
  const repoDir = path.join(workDir, "repo");
  const setupStart = Date.now();
  await prepareWorkspace(task, repoDir);
  record.setupSeconds = (Date.now() - setupStart) / 1000;
  const agentLog = path.join(logDir, "agent.log");
  if (context.oracle) await runOracle(task, repoDir, agentLog, context.oracle);
  else Object.assign(record, await runAgent(task, arm, context, { workDir, repoDir, logDir, agentLog }));
  const result = await grade(task, repoDir, agentLog);
  fs.writeFileSync(path.join(logDir, "grade.log"), result.output);
  record.passed = result.passed;
  record.gradeTail = result.output.split("\n").slice(-6).join("\n");
}

async function runOracle(task, repoDir, agentLog, oracle) {
  fs.writeFileSync(agentLog, oracle === "gold" ? task.goldOutput ?? "" : "");
  if (oracle === "gold" && task.gold) await applyPatch(path.join(task.dir, task.gold), repoDir, false);
}

async function runAgent(task, arm, context, { workDir, repoDir, logDir, agentLog }) {
  const harnessDir = path.join(workDir, "harness");
  copyHarness(context.harnessSource, harnessDir, arm.settings.config);
  const timeoutSeconds = context.timeout ?? task.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const result = await runHarness({
    harnessDir,
    sourceDir: context.harnessSource,
    repoDir,
    taskText: task.task,
    env: arm.settings.env,
    timeoutMs: timeoutSeconds * 1000,
  });
  fs.writeFileSync(agentLog, result.output);
  if (result.traceFile) fs.copyFileSync(result.traceFile, path.join(logDir, "trace.jsonl"));
  const summary = summarizeTrace(readTrace(result.traceFile), result.output);
  if (result.timedOut) summary.outcome = "timeout";
  return { ...summary, seconds: result.seconds, exitCode: result.code };
}
