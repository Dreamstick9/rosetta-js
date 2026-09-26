import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { resetShell } from "../tools/shell.js";
import { writeDimLine, writeError } from "../ui.js";
import { DEFAULT_WORK_FOLDER, enterWorkingFolder, expandHome, isInsideHarness } from "../workdir.js";
import { cloneRepository, describeGitError, isCheckoutOf, updateCheckout } from "./checkout.js";
import { fetchIssue } from "./github.js";
import { buildTaskMessage } from "./message.js";
import { parseTaskReference } from "./parse.js";
import { findGithubToken, hideToken } from "./token.js";

const PINNED_FOLDER_VARIABLES = ["REPO", "TARGET_REPO"];

export async function runIntake(text, trace, signal) {
  const reference = parseTaskReference(text);
  if (!reference) return text;
  const startedAt = Date.now();
  const token = findGithubToken();
  const problems = [];
  const checkout = await prepareFolder(reference, token, signal, problems);
  const fetched = await fetchIssueText(reference, token, signal, problems);
  if (problems.length > 0) writeError(`Intake: ${hideToken(problems.join("; "), token)}; continuing in ${PROJECT_ROOT}`);
  trace.recordIntake({
    repo: `${reference.owner}/${reference.repo}`,
    issue: reference.number,
    folder: PROJECT_ROOT,
    checkout: checkout.action,
    ms: Date.now() - startedAt,
  });
  return buildTaskMessage({ reference, folderNote: checkout.note, ...fetched });
}

async function prepareFolder(reference, token, signal, problems) {
  const pinned = PINNED_FOLDER_VARIABLES.find((name) => process.env[name]);
  if (pinned) return { action: "pinned", note: `working folder ${PROJECT_ROOT}, set by ${pinned}` };
  const folder = chooseCloneFolder(reference);
  const name = `${reference.owner}/${reference.repo}`;
  if (isInsideHarness(folder)) return skipCheckout(problems, `not cloning ${name} into ${folder}, which is inside rosetta-js`);
  try {
    const action = await checkOut(reference, folder, token, signal, problems);
    enterWorkingFolder(folder, `${action} ${name}`);
    resetShell();
    return { action, note: `cloned at ${PROJECT_ROOT}` };
  } catch (error) {
    signal.throwIfAborted();
    return skipCheckout(problems, `could not clone ${name}: ${hideToken(describeGitError(error), token)}`);
  }
}

function chooseCloneFolder({ owner, repo }) {
  if (process.env.REPO_PATH) return expandHome(process.env.REPO_PATH);
  const base = process.env.WORK_DIR ? expandHome(process.env.WORK_DIR) : DEFAULT_WORK_FOLDER;
  return path.join(base, `${owner}-${repo}`);
}

async function checkOut(reference, folder, token, signal, problems) {
  if (!(await isCheckoutOf(folder, reference))) {
    await cloneRepository(reference, folder, token, signal);
    return "cloned";
  }
  try {
    await updateCheckout(folder, token, signal);
  } catch (error) {
    signal.throwIfAborted();
    problems.push(`could not update ${folder}: ${hideToken(describeGitError(error), token)}`);
  }
  return "reused";
}

function skipCheckout(problems, problem) {
  problems.push(problem);
  return { action: "not_cloned", note: `not cloned; working folder ${PROJECT_ROOT}` };
}

async function fetchIssueText(reference, token, signal, problems) {
  if (reference.number === null) return {};
  try {
    const issue = await fetchIssue(reference, token, signal);
    writeDimLine(`Fetched #${reference.number}: ${issue.title} (${issue.comments.length} comments)`);
    return { issue };
  } catch (error) {
    signal.throwIfAborted();
    const issueProblem = hideToken(error.message, token);
    problems.push(`could not fetch #${reference.number}: ${issueProblem}`);
    return { issueProblem };
  }
}
