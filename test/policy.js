import fs from "node:fs";
import { setProjectRoot } from "../src/config.js";
import { checkToolCall } from "../src/policy.js";

const PROBE_FOLDER = "/tmp/rjs-probe";
const ALLOWED = [
  ["bash", "ls ~ 2>/dev/null"],
  ["bash", 'printf "a\\nb"'],
  ["bash", "cd sub && rm -rf build"],
  ["bash", "pip install -e ."],
  ["bash", "npm test 2>&1 | tail -n 20"],
  ["bash", "echo done >&2"],
  ["bash", "rm -rf /tmp/rjs-scratch"],
  ["bash", "git status && git diff"],
  ["bash", "cat > notes.txt <<'EOF'\nrm -rf ~\nEOF"],
  ["bash", "python3 -c 'print(1)' > out.txt"],
  ["write_file", "src/app.js"],
  ["read_file", "README.md"],
];
const BLOCKED = [
  ["bash", "rm -rf ~"],
  ["bash", "rm -rf ."],
  ["bash", "cd .. && rm -rf rjs-probe"],
  ["bash", "rm -rf /"],
  ["bash", "git push origin main"],
  ["bash", "git push --force"],
  ["bash", "git remote set-url origin https://example.com/x.git"],
  ["bash", "cat ~/.ssh/id_rsa"],
  ["bash", "cd ~/.aws && cat credentials"],
  ["bash", "echo $AI_API_KEY"],
  ["bash", 'echo "${GITHUB_TOKEN}"'],
  ["bash", "printenv GH_TOKEN"],
  ["bash", "echo hi > ~/outside.txt"],
  ["bash", 'bash -c "rm -rf $HOME"'],
  ["bash", "cp secret.txt /etc/secret.txt"],
  ["bash", "gh auth token"],
  ["write_file", "/etc/hosts"],
  ["read_file", "~/.netrc"],
];

function main() {
  fs.mkdirSync(`${PROBE_FOLDER}/sub`, { recursive: true });
  setProjectRoot(PROBE_FOLDER);
  const failures = [...ALLOWED.map((probe) => runProbe(probe, false)), ...BLOCKED.map((probe) => runProbe(probe, true))].filter(Boolean);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL policy: ${failure}`);
    process.exit(1);
  }
  console.log(`PASS policy: ${ALLOWED.length} allowed and ${BLOCKED.length} blocked probes.`);
}

function runProbe([tool, value], shouldBlock) {
  const args = tool === "bash" ? { command: value } : { path: value.replace(/^~/, process.env.HOME) };
  const reason = checkToolCall(tool, args, PROBE_FOLDER);
  const verdict = reason ? `BLOCK (${reason})` : "ALLOW";
  if (process.env.SHOW_PROBES) console.log(`${verdict.padEnd(70)} ${tool} ${JSON.stringify(value)}`);
  if (Boolean(reason) === shouldBlock) return null;
  return `${tool} ${JSON.stringify(value)} gave ${verdict}`;
}

main();
