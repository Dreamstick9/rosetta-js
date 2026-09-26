import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PROJECT_ROOT } from "../config.js";

const COMMAND_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2000;
const SHELL_SETUP = "trap 'true' INT\n";

class ShellSession {
  constructor() {
    this.child = null;
    this.cwd = PROJECT_ROOT;
    this.output = "";
    this.marker = null;
    this.resolveCommand = null;
  }

  start() {
    this.child = spawn("bash", ["--noprofile", "--norc"], { cwd: this.cwd, detached: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (text) => this.receive(text));
    this.child.stderr.on("data", (text) => this.receive(text));
    this.child.on("exit", () => this.handleExit());
    this.child.stdin.write(SHELL_SETUP);
  }

  async run(command, signal) {
    if (!this.child) this.start();
    const marker = `__ROSETTA_DONE_${randomUUID().replaceAll("-", "")}__`;
    const commandEnd = this.waitForMarker(marker);
    this.child.stdin.write(buildScript(command, marker));
    const finished = await Promise.race([commandEnd, waitForAbort(signal, COMMAND_TIMEOUT_MS)]);
    if (finished) return finished;
    const stopReason = signal.aborted ? "interrupted by the user" : `timed out after ${COMMAND_TIMEOUT_MS / 1000}s`;
    const stoppedResult = await this.stopCommand(commandEnd);
    const notes = [`[command ${stopReason}]`, stoppedResult.note].filter(Boolean);
    return { ...stoppedResult, note: notes.join("\n") };
  }

  waitForMarker(marker) {
    this.output = "";
    this.marker = marker;
    return new Promise((resolve) => {
      this.resolveCommand = resolve;
    });
  }

  receive(text) {
    this.output += text;
    if (!this.marker) return;
    const result = parseMarkerLine(this.output, this.marker);
    if (result) this.finishCommand(result);
  }

  finishCommand(result) {
    this.marker = null;
    this.cwd = result.cwd;
    const resolve = this.resolveCommand;
    this.resolveCommand = null;
    if (resolve) resolve(result);
  }

  handleExit() {
    this.child = null;
    if (!this.marker) return;
    const note = "[the shell exited; a fresh shell starts with the next command]";
    this.finishCommand({ output: this.output, exitCode: null, cwd: this.cwd, note });
  }

  async stopCommand(commandEnd) {
    this.signalGroup("SIGINT");
    const killTimer = setTimeout(() => this.signalGroup("SIGKILL"), KILL_GRACE_MS);
    const result = await commandEnd;
    clearTimeout(killTimer);
    return result;
  }

  signalGroup(signalName) {
    if (!this.child) return;
    try {
      process.kill(-this.child.pid, signalName);
    } catch {
      this.child = null;
    }
  }
}

function buildScript(command, marker) {
  const delimiter = `${marker}_COMMAND`;
  return [
    `IFS= read -r -d '' __rosetta_command <<'${delimiter}'`,
    command,
    delimiter,
    `eval "$__rosetta_command" < /dev/null 2>&1`,
    "__rosetta_status=$?",
    `printf '\\n%s %s %s\\n' '${marker}' "$__rosetta_status" "$(pwd -P)"`,
    "",
  ].join("\n");
}

function parseMarkerLine(output, marker) {
  const markerStart = output.indexOf(`${marker} `);
  if (markerStart === -1) return null;
  const lineEnd = output.indexOf("\n", markerStart);
  if (lineEnd === -1) return null;
  const fields = output.slice(markerStart + marker.length + 1, lineEnd).split(" ");
  const commandOutput = output.slice(0, markerStart).trimEnd();
  return { output: commandOutput, exitCode: Number(fields[0]), cwd: fields.slice(1).join(" ") };
}

function waitForAbort(signal, timeoutMs) {
  const stopSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  return new Promise((resolve) => {
    if (stopSignal.aborted) resolve(null);
    stopSignal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

const session = new ShellSession();

export function stopShell() {
  session.signalGroup("SIGKILL");
}

export const bashTool = {
  definition: {
    type: "function",
    function: {
      name: "bash",
      description: "Run a command in one persistent bash shell (cd, env vars and virtualenvs carry over). No interactive input. Timeout 120s.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The bash command to run." } },
        required: ["command"],
      },
    },
  },
  run: runBash,
};

async function runBash({ command }, { signal }) {
  const result = await session.run(command, signal);
  return formatResult(result);
}

function formatResult({ output, exitCode, cwd, note }) {
  const lines = [output || "(no output)"];
  if (note) lines.push(note);
  if (exitCode !== null) lines.push(`[exit code ${exitCode}]`);
  if (cwd !== PROJECT_ROOT) lines.push(`[shell cwd: ${cwd}]`);
  return lines.join("\n");
}
