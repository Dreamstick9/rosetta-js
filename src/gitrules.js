const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const REMOTE_CHANGES = new Set(["add", "set-url", "remove", "rm", "rename", "set-head", "set-branches"]);
const GH_WRITE_VERBS = new Set(["create", "merge", "delete", "edit", "close", "reopen", "comment", "review", "push", "sync", "fork", "upload", "transfer", "archive"]);

export function checkGitCommand(args) {
  const index = findGitSubcommand(args);
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === "push") return "git push is not allowed";
  if (subcommand === "remote" && REMOTE_CHANGES.has(rest[0])) return "changing git remotes is not allowed";
  if (subcommand === "config" && rest.some(isRemoteSetting)) return "changing git remotes is not allowed";
  return null;
}

function findGitSubcommand(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
  }
  return index;
}

function isRemoteSetting(arg) {
  if (arg.startsWith("remote.") || arg.startsWith("url.")) return true;
  return arg.startsWith("branch.") && arg.endsWith(".remote");
}

export function checkGhCommand(args) {
  if (args[0] === "auth") return "gh auth can reveal credentials";
  if (args.some((arg) => GH_WRITE_VERBS.has(arg))) return `gh ${args.slice(0, 2).join(" ")} changes things on GitHub`;
  if (args[0] === "api" && args.some((arg) => arg === "-X" || arg === "--method" || arg.startsWith("--method="))) return "gh api with a method can change things on GitHub";
  return null;
}
