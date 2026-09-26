import { CONFIG } from "../config.js";

const API_ROOT = "https://api.github.com";
const USER_AGENT = "rosetta-js";
const INTAKE = CONFIG.intake;

export async function fetchIssue({ owner, repo, number }, token, signal) {
  const issuePath = `/repos/${owner}/${repo}/issues/${number}`;
  const issue = await requestJson(issuePath, token, signal);
  const comments = issue.comments > 0 ? await fetchComments(issuePath, token, signal) : [];
  return {
    title: issue.title ?? "",
    body: limitText(issue.body ?? "", INTAKE.maxBodyChars),
    comments,
    hiddenComments: Math.max(0, (issue.comments ?? 0) - comments.length),
  };
}

async function fetchComments(issuePath, token, signal) {
  if (INTAKE.maxComments <= 0) return [];
  const perPage = Math.min(INTAKE.maxComments, 100);
  const comments = await requestJson(`${issuePath}/comments?per_page=${perPage}`, token, signal);
  const shown = [];
  for (const comment of comments.slice(0, INTAKE.maxComments)) {
    shown.push({ author: comment.user?.login ?? "unknown", text: limitText(comment.body ?? "", INTAKE.maxCommentChars) });
  }
  return shown;
}

async function requestJson(apiPath, token, signal) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const timeout = AbortSignal.timeout(INTAKE.apiTimeoutSeconds * 1000);
  const response = await fetch(`${API_ROOT}${apiPath}`, { headers, signal: AbortSignal.any([signal, timeout]) });
  if (!response.ok) throw new Error(`GitHub API answered ${response.status} ${response.statusText} for ${apiPath}`);
  return response.json();
}

function limitText(text, maxChars) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[... cut after ${maxChars} characters]`;
}
