import path from "node:path";

const READING_GIT_COMMANDS = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "cat-file", "describe", "shortlog", "help"]);
const INSTALLERS = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "cargo", "go", "gem", "bundle", "poetry", "uv"]);
const INSTALL_VERBS = new Set(["install", "i", "add", "ci", "uninstall", "remove", "update", "upgrade", "get", "sync", "link"]);
const WRITING_COMMANDS = new Set(["patch"]);

export function checkReadOnlyCommand(words, place) {
  if (!place.readOnly || words.length === 0) return null;
  const name = path.basename(words[0]);
  const args = words.slice(1);
  if (name === "git") return checkReadOnlyGit(args);
  if (INSTALLERS.has(name) && args.some((arg) => INSTALL_VERBS.has(arg))) return `${name} ${args[0]} changes files, and this agent is read-only`;
  if (WRITING_COMMANDS.has(name)) return `${name} changes files, and this agent is read-only`;
  return null;
}

function checkReadOnlyGit(args) {
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (subcommand === undefined || READING_GIT_COMMANDS.has(subcommand)) return null;
  return `git ${subcommand} can change the repository, and this agent is read-only`;
}
