const ITEM_LABELS = { issue: "Issue", pull: "Pull request" };
const URL_SEGMENTS = { issue: "issues", pull: "pull" };

export function buildTaskMessage({ reference, folderNote, issue, issueProblem }) {
  const parts = [`Repository: ${reference.owner}/${reference.repo} (${folderNote})`];
  if (reference.number !== null) parts.push(describeItem(reference, issue, issueProblem));
  if (reference.rest) parts.push(reference.rest);
  return parts.join("\n");
}

function describeItem(reference, issue, issueProblem) {
  const label = `${ITEM_LABELS[reference.kind]} #${reference.number}`;
  const url = `https://github.com/${reference.owner}/${reference.repo}/${URL_SEGMENTS[reference.kind]}/${reference.number}`;
  if (!issue) return `${label}: ${url} (its text could not be fetched: ${issueProblem})\n`;
  const lines = [`${label}: ${issue.title}`, "", issue.body || "(no description)"];
  if (issue.comments.length > 0) lines.push("", "Comments:", ...issue.comments.map(formatComment));
  if (issue.hiddenComments > 0) lines.push(`(${issue.hiddenComments} more comments not shown)`);
  lines.push("");
  return lines.join("\n");
}

function formatComment({ author, text }) {
  return `- ${author}: ${text}`;
}
