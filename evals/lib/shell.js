import { spawn } from "node:child_process";

export function quote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

export function sh(command, options = {}) {
  return run("bash", ["-c", command], options);
}

export function run(file, args, { cwd, env = process.env, input = "", timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, detached: true });
    const chunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => chunks.push(data));
    child.on("error", (error) => chunks.push(Buffer.from(`\n${error.message}\n`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup(child);
      resolve({ code, timedOut, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

export function lastLines(text, count) {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
