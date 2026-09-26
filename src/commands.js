import os from "node:os";
import path from "node:path";
import { buildChildEnvironment, isSecretVariableName } from "./environment.js";
import { describeDeleteProblem, describeReadProblem, describeWriteProblem } from "./paths.js";
import { parseShell } from "./shellwords.js";
import { checkGitCommand, checkGhCommand } from "./gitrules.js";

const MAX_DEPTH = 4;
const SHELL_ENVIRONMENT = buildChildEnvironment();
const PREFIX_WORDS = new Set(["sudo", "nohup", "time", "command", "exec", "nice", "builtin", "then", "do", "else", "elif", "if", "while", "until", "!", "{"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const WRITE_ALL_COMMANDS = new Set(["mv", "touch", "mkdir", "tee", "truncate", "chmod", "chown", "chgrp"]);
const WRITE_LAST_COMMANDS = new Set(["cp", "ln", "install", "rsync"]);
const DELETE_COMMANDS = new Set(["rmdir", "unlink", "shred"]);
const WRITING_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const OUTPUT_FLAGS = new Set(["-o", "--output", "-O", "--output-document", "-P"]);
const FILE_DESCRIPTOR_PATTERN = /^(\d+|-)$/;

export function checkCommandLine(commandLine, cwd, depth = 0) {
  if (depth > MAX_DEPTH) return "the command nests shells too deeply to check";
  const parsed = parseShell(commandLine, SHELL_ENVIRONMENT);
  const secret = parsed.variables.find(isSecretVariableName);
  if (secret) return `it reads the secret variable $${secret}`;
  for (const substitution of parsed.substitutions) {
    const reason = checkCommandLine(substitution, cwd, depth + 1);
    if (reason) return reason;
  }
  let currentCwd = cwd;
  for (const command of parsed.commands) {
    const words = stripPrefixWords(command.words);
    const reason = checkRedirects(command.redirects, currentCwd) ?? checkWords(words, currentCwd) ?? checkCommand(words, command, currentCwd, depth);
    if (reason) return reason;
    currentCwd = nextCwd(words, currentCwd);
  }
  return null;
}

function stripPrefixWords(words) {
  let start = 0;
  while (start < words.length && (PREFIX_WORDS.has(words[start]) || /^[A-Za-z_]\w*=/.test(words[start]))) start++;
  if (words[start] === "env") return stripPrefixWords(words.slice(start + 1).filter((word) => !word.startsWith("-")));
  return words.slice(start);
}

function checkRedirects(redirects, cwd) {
  for (const { op, target } of redirects) {
    if (op === "<<<") continue;
    if ((op === ">&" || op === "<&") && FILE_DESCRIPTOR_PATTERN.test(target)) continue;
    const absolute = path.resolve(cwd, target);
    const reason = WRITING_REDIRECTS.has(op) || op === ">&" ? describeWriteProblem(absolute) : describeReadProblem(absolute);
    if (reason) return reason;
  }
  return null;
}

function checkWords(words, cwd) {
  for (const word of words) {
    const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : null;
    const reason = describeReadProblem(path.resolve(cwd, word)) ?? (value ? describeReadProblem(path.resolve(cwd, value)) : null);
    if (reason) return reason;
  }
  return null;
}

function checkCommand(words, command, cwd, depth) {
  if (words.length === 0) return null;
  const name = path.basename(words[0]);
  const args = words.slice(1);
  if (name === "rm") return checkDeletes(pathArguments(args), cwd, args.some(isRecursiveFlag));
  if (DELETE_COMMANDS.has(name)) return checkDeletes(pathArguments(args), cwd, false);
  if (WRITE_ALL_COMMANDS.has(name)) return checkWrites(pathArguments(args), cwd);
  if (WRITE_LAST_COMMANDS.has(name)) return checkWrites(pathArguments(args).slice(-1), cwd);
  if ((name === "sed" || name === "perl") && args.some((arg) => /^-\w*i/.test(arg))) return checkWrites(pathArguments(args), cwd);
  if (name === "curl" || name === "wget") return checkWrites(flagValues(args, OUTPUT_FLAGS), cwd);
  if (name === "dd") return checkWrites(args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)), cwd);
  if (name === "find") return checkFind(args, cwd);
  if (name === "git") return checkGitCommand(args);
  if (name === "gh") return checkGhCommand(args);
  if (name === "printenv") return checkPrintenv(args);
  if (name === "eval") return checkCommandLine(args.join(" "), cwd, depth + 1);
  if (SHELLS.has(name)) return checkShellCommand(args, command, cwd, depth);
  return null;
}

function pathArguments(args) {
  const separator = args.indexOf("--");
  if (separator !== -1) return [...args.slice(0, separator).filter((arg) => !arg.startsWith("-")), ...args.slice(separator + 1)];
  return args.filter((arg) => !arg.startsWith("-"));
}

function isRecursiveFlag(arg) {
  return arg === "--recursive" || /^-[a-zA-Z]*[rR]/.test(arg);
}

function flagValues(args, flags) {
  const values = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (flags.has(args[index])) values.push(args[index + 1]);
  }
  return values;
}

function checkDeletes(targets, cwd, recursive) {
  for (const target of targets) {
    const reason = describeDeleteProblem(path.resolve(cwd, target), recursive);
    if (reason) return reason;
  }
  return null;
}

function checkWrites(targets, cwd) {
  for (const target of targets) {
    const reason = describeWriteProblem(path.resolve(cwd, target));
    if (reason) return reason;
  }
  return null;
}

function checkFind(args, cwd) {
  const deletes = args.includes("-delete") || args.some((arg, index) => arg === "-exec" && args[index + 1] === "rm");
  if (!deletes) return null;
  const firstExpression = args.findIndex((arg) => arg.startsWith("-") || arg === "(" || arg === "!");
  const roots = firstExpression === -1 ? args : args.slice(0, firstExpression);
  return checkDeletes(roots.length > 0 ? roots : ["."], cwd, true);
}

function checkPrintenv(args) {
  if (args.length === 0) return null;
  const secret = args.find(isSecretVariableName);
  return secret ? `it prints the secret variable ${secret}` : null;
}

function checkShellCommand(args, command, cwd, depth) {
  const flagIndex = args.findIndex((arg) => /^-\w*c$/.test(arg));
  if (flagIndex !== -1) return checkCommandLine(args[flagIndex + 1] ?? "", cwd, depth + 1);
  for (const body of command.heredocBodies) {
    const reason = checkCommandLine(body, cwd, depth + 1);
    if (reason) return reason;
  }
  return null;
}

function nextCwd(words, cwd) {
  if (words[0] !== "cd" && words[0] !== "pushd") return cwd;
  const target = pathArguments(words.slice(1))[0];
  if (target === undefined) return os.homedir();
  if (target === "-") return cwd;
  return path.resolve(cwd, target);
}
