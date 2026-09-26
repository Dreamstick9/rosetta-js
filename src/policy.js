import { CONFIG } from "./config.js";
import { checkCommandLine } from "./commands.js";
import { describeDeleteProblem, describeReadProblem, describeWriteProblem } from "./paths.js";
import { resolvePath } from "./tools/files.js";

const READ_TOOLS = new Set(["list_files", "read_file", "search"]);
const WRITE_TOOLS = new Set(["create_file", "write_file", "edit_file"]);

export function checkToolCall(name, args, shellCwd) {
  if (CONFIG.policy === "off") return null;
  if (name === "bash") return checkCommandLine(args.command, shellCwd);
  if (typeof args.path !== "string") return null;
  const target = resolvePath(args.path);
  if (READ_TOOLS.has(name)) return describeReadProblem(target);
  if (WRITE_TOOLS.has(name)) return describeWriteProblem(target);
  if (name === "delete_file") return describeDeleteProblem(target, false);
  return null;
}

export function describeBlock(reason) {
  return `Blocked by policy: ${reason}. Choose another way.`;
}
