const USAGE = `Usage: node evals/run.js [options]
  --tasks id1,id2      run only these tasks
  --quick              run only the tasks marked quick
  --runs N             repeat every task N times (default 1)
  --parallel N         run N jobs at once (default 1, sequential)
  --env "K=v a.b=c"    harness settings for every run: UPPER_CASE keys are env vars, dotted keys patch config.json
  --ab "A" "B"         A/B mode: run both settings arms and print deltas
  --oracle gold|none   skip the agent: apply the reference fix, or change nothing (checks the tasks)
  --harness DIR        rosetta-js folder to evaluate (default: this checkout)
  --timeout SECONDS    per-task agent timeout (default: the task's timeoutSeconds or 900)
  --keep               keep the work folders`;

const VALUE_FLAGS = new Set(["--tasks", "--runs", "--parallel", "--env", "--oracle", "--harness", "--timeout"]);

export function parseArgs(argv) {
  const options = { tasks: null, quick: false, runs: 1, parallel: 1, env: [], ab: null, oracle: null, harness: null, timeout: null, keep: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return exitWith(USAGE, 0);
    if (flag === "--quick") options.quick = true;
    else if (flag === "--keep") options.keep = true;
    else if (flag === "--ab") options.ab = [argv[++index], argv[++index]];
    else if (VALUE_FLAGS.has(flag)) setValue(options, flag, argv[++index]);
    else return exitWith(`Unknown option ${flag}\n${USAGE}`, 1);
  }
  return checkOptions(options);
}

function setValue(options, flag, value) {
  if (value === undefined) exitWith(`${flag} needs a value`, 1);
  if (flag === "--tasks") options.tasks = value.split(",").filter(Boolean);
  if (flag === "--runs") options.runs = Number(value);
  if (flag === "--parallel") options.parallel = Number(value);
  if (flag === "--env") options.env.push(value);
  if (flag === "--oracle") options.oracle = value;
  if (flag === "--harness") options.harness = value;
  if (flag === "--timeout") options.timeout = Number(value);
}

function checkOptions(options) {
  if (options.ab && options.ab.some((arm) => arm === undefined)) exitWith("--ab needs two settings arguments", 1);
  if (!(options.runs >= 1) || !(options.parallel >= 1)) exitWith("--runs and --parallel must be at least 1", 1);
  if (options.oracle && !["gold", "none"].includes(options.oracle)) exitWith("--oracle must be gold or none", 1);
  return options;
}

function exitWith(message, code) {
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}
