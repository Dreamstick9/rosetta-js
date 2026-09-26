import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ssh", "scp"]);
const PACKAGE_TOOLS = new Set(["pip", "pip3", "npm", "yarn", "pnpm"]);
const INSTALL_WORDS = new Set(["install", "i", "add", "ci"]);
const SYSTEM_PACKAGE_MANAGERS = new Set(["brew", "apt", "apt-get"]);
const WRITING_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "ln", "touch", "mkdir", "tee", "truncate", "chmod", "chown"]);
const COMMAND_PREFIXES = new Set(["sudo", "command", "exec", "time", "nohup", "env"]);
const COMMAND_SEPARATORS = new Set([";", "|", "\n", "(", ")", "`"]);
const WRITABLE_ROOTS = [PROJECT_ROOT, "/tmp", "/private/tmp"];
const HOME_PREFIXES = ["~", "$HOME", "${HOME}"];
const WRITABLE_FILES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

export function findRiskReason(commandLine, cwd) {
  for (const words of splitIntoCommands(commandLine)) {
    const reason = findCommandRisk(dropPrefixes(words), cwd);
    if (reason) return reason;
  }
  return null;
}

function findCommandRisk(words, cwd) {
  if (words.length === 0) return null;
  const name = path.basename(words[0]);
  const args = words.slice(1);
  if (NETWORK_COMMANDS.has(name)) return `network command (${name})`;
  if (isPackageInstall(name, args)) return "package install";
  if (name === "rm" && hasRecursiveFlag(args)) return "recursive delete (rm -r)";
  const gitRisk = findGitRisk(name, args);
  if (gitRisk) return gitRisk;
  const outsideTarget = findWriteTargets(name, args).find((target) => isOutsideWritablePlaces(target, cwd));
  if (outsideTarget) return `writes outside the project (${outsideTarget})`;
  return null;
}

function isPackageInstall(name, args) {
  if (SYSTEM_PACKAGE_MANAGERS.has(name)) return true;
  if (name.startsWith("python") && args[0] === "-m" && PACKAGE_TOOLS.has(args[1])) return INSTALL_WORDS.has(args[2]);
  return PACKAGE_TOOLS.has(name) && INSTALL_WORDS.has(args[0]);
}

function hasRecursiveFlag(args) {
  for (const arg of args) {
    if (arg === "--recursive") return true;
    if (arg.startsWith("-") && !arg.startsWith("--") && (arg.includes("r") || arg.includes("R"))) return true;
  }
  return false;
}

function findGitRisk(name, args) {
  if (name !== "git") return null;
  if (args[0] === "push") return "git push";
  if (args[0] === "clean") return "git clean";
  if (args[0] === "reset" && args.includes("--hard")) return "git reset --hard";
  return null;
}

function findWriteTargets(name, args) {
  const redirectTargets = [];
  const plainArgs = [];
  for (let i = 0; i < args.length; i++) {
    const redirect = readRedirect(args[i], args[i + 1]);
    if (!redirect) {
      plainArgs.push(args[i]);
      continue;
    }
    if (redirect.usesNextWord) i++;
    if (redirect.target) redirectTargets.push(redirect.target);
  }
  return redirectTargets.concat(writtenPaths(name, plainArgs));
}

function readRedirect(word, nextWord) {
  const arrowIndex = word.indexOf(">");
  if (arrowIndex === -1 || !isRedirectPrefix(word.slice(0, arrowIndex))) return null;
  let rest = word.slice(arrowIndex + 1);
  if (rest.startsWith(">") || rest.startsWith("|")) rest = rest.slice(1);
  if (rest.startsWith("&")) return { target: null, usesNextWord: false };
  if (rest === "") return { target: nextWord ?? null, usesNextWord: true };
  return { target: rest, usesNextWord: false };
}

function isRedirectPrefix(prefix) {
  return prefix === "" || prefix === "&" || /^\d+$/.test(prefix);
}

function writtenPaths(name, args) {
  if (!WRITING_COMMANDS.has(name)) return [];
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (name === "cp" || name === "ln") return paths.slice(-1);
  return paths;
}

function isOutsideWritablePlaces(target, cwd) {
  if (WRITABLE_FILES.has(target)) return false;
  const absolute = path.resolve(cwd, expandHome(target));
  return !WRITABLE_ROOTS.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`));
}

function expandHome(target) {
  for (const prefix of HOME_PREFIXES) {
    if (target === prefix || target.startsWith(`${prefix}/`)) return os.homedir() + target.slice(prefix.length);
  }
  return target;
}

function dropPrefixes(words) {
  let start = 0;
  while (start < words.length && (COMMAND_PREFIXES.has(words[start]) || isAssignment(words[start]))) start++;
  return words.slice(start);
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function splitIntoCommands(commandLine) {
  const state = { commands: [[]], word: "", inWord: false, quote: null };
  for (let i = 0; i < commandLine.length; i++) {
    i = readCharacter(state, commandLine, i);
  }
  endWord(state);
  return state.commands.filter((words) => words.length > 0);
}

function readCharacter(state, text, i) {
  const char = text[i];
  if (char === state.quote) {
    state.quote = null;
  } else if (char === "\\" && state.quote !== "'") {
    addToWord(state, text[i + 1] ?? "");
    return i + 1;
  } else if (state.quote) {
    addToWord(state, char);
  } else if (char === "'" || char === '"') {
    state.quote = char;
    state.inWord = true;
  } else if (char === " " || char === "\t") {
    endWord(state);
  } else if (isSeparator(state, text, i)) {
    endWord(state);
    state.commands.push([]);
  } else {
    addToWord(state, char);
  }
  return i;
}

function isSeparator(state, text, i) {
  if (text[i] === "&") return !state.word.endsWith(">") && text[i + 1] !== ">";
  return COMMAND_SEPARATORS.has(text[i]);
}

function addToWord(state, char) {
  state.word += char;
  state.inWord = true;
}

function endWord(state) {
  if (state.inWord) state.commands.at(-1).push(state.word);
  state.word = "";
  state.inWord = false;
}
