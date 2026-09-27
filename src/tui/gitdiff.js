import { spawnSync } from "node:child_process";

const MAX_BUFFER = 32_000_000;
const MAX_UNTRACKED = 100;

export function readGitDiff(root) {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return { error: "Not inside a git repository." };
  const againstHead = git(root, ["diff", "--no-color", "HEAD"]);
  const tracked = againstHead.status === 0 ? againstHead.stdout : git(root, ["diff", "--no-color"]).stdout;
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).stdout.split("\n").filter(Boolean);
  const parts = [tracked];
  for (const file of untracked.slice(0, MAX_UNTRACKED)) parts.push(git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", file]).stdout);
  if (untracked.length > MAX_UNTRACKED) parts.push(`\n… ${untracked.length - MAX_UNTRACKED} more untracked files\n`);
  return { text: parts.join("") };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER });
  return { status: result.status, stdout: result.stdout ?? "" };
}
