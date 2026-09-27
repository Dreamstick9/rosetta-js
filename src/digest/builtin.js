const MAX_LINES = 40;
const PATTERNS = {
  "pytest": {
    kept: /^_{3,} .+ _{3,}$|^E\s+\S|^\S+\.py:\d+:|^(?:FAIL|ERROR): /,
    summary: /^=+ .*(?:passed|failed|error).* =+$|^\d+ (?:passed|failed)\b.* in [\d.]+s|^Ran \d+ tests? in |^(?:OK|FAILED)(?: \(.*\))?$/,
  },
  "jest": {
    kept: /●|Expected|Received|^\s*>\s*\d+ \||^\s*(?:FAIL|×|✗)\s/,
    summary: /^\s*Tests?:|^\s*Test Suites:|^\s*Test Files /,
  },
};

export function builtinDigest(name, output) {
  const patterns = PATTERNS[name];
  if (!patterns) return null;
  const lines = output.split("\n");
  const summary = lines.filter((line) => patterns.summary.test(line));
  const kept = lines.filter((line) => patterns.kept.test(line));
  if (kept.length === 0) return null;
  return [...summary, ...kept.slice(0, MAX_LINES - summary.length)].join("\n");
}
