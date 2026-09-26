import { COMMAND_TIMEOUT_MS, ShellSession } from "./shellsession.js";

export const MAIN_SHELL = new ShellSession();

export function createShellSession(root) {
  return new ShellSession(root);
}

export function stopShellSession(session) {
  session.stop();
}

export function stopShell() {
  MAIN_SHELL.stop();
}

export function resetShell() {
  MAIN_SHELL.reset();
}

export const bashTool = {
  definition: {
    type: "function",
    function: {
      name: "bash",
      description: `Run a command in one persistent bash shell (cd, env vars and virtualenvs carry over). No interactive input. Timeout ${COMMAND_TIMEOUT_MS / 1000}s.`,
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The bash command to run." } },
        required: ["command"],
      },
    },
  },
  run: runBash,
};

async function runBash({ command }, { signal, shell, root }) {
  const result = await shell.run(command, signal);
  return formatResult(result, root);
}

function formatResult({ output, exitCode, cwd, note }, root) {
  const lines = [output || "(no output)"];
  if (note) lines.push(note);
  if (exitCode !== null) lines.push(`[exit code ${exitCode}]`);
  if (cwd !== root) lines.push(`[shell cwd: ${cwd}]`);
  return lines.join("\n");
}
