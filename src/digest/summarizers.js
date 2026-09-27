const SUMMARIZERS = [
  {
    name: "pytest",
    skill: "backend-api",
    script: "pytest_failures.py",
    logArgs: (file) => ["--log", file],
    command: /\bpytest\b|\bunittest\b|manage\.py test/,
    output: /short test summary info|^=+ FAILURES =+$|^Ran \d+ tests? in /m,
  },
  {
    name: "cargo test",
    skill: "rust",
    script: "cargo_test_fail.py",
    logArgs: (file) => [file],
    command: /\bcargo\s+(?:\+\S+\s+)?(?:test|nextest)\b/,
    output: /^test result: (?:ok|FAILED)\./m,
  },
  {
    name: "cargo",
    skill: "rust",
    script: "cargo_errors.py",
    logArgs: (file) => [file],
    command: /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy|run)\b/,
    output: /^error\[E\d{4}\]:/m,
  },
  {
    name: "go test",
    skill: "go",
    script: "go_test_fail.py",
    logArgs: (file) => [file],
    command: /\bgo\s+test\b/,
    output: /^--- FAIL: /m,
  },
  {
    name: "tsc",
    skill: "node-typescript",
    script: "tsc_summary.py",
    logArgs: (file) => ["--log", file],
    command: /\btsc\b|\btypecheck\b/,
    output: /error TS\d+:/,
  },
  {
    name: "jest",
    skill: "web-frontend",
    script: "js_test_failures.py",
    logArgs: (file) => [file],
    command: /\b(?:jest|vitest|mocha|playwright)\b/,
    output: /^\s*Test Suites: |^\s*Test Files |^\s*Tests:\s+\d+/m,
  },
  {
    name: "junit",
    skill: "java-kotlin",
    script: "junit_fail.py",
    logArgs: (file) => [file],
    command: /\b(?:mvn|mvnw|gradle|gradlew)\b/,
    output: /Tests run: \d+, Failures: \d+/,
  },
  {
    name: "cc",
    skill: "c-cpp",
    script: "cc_errors.py",
    logArgs: (file) => [file],
    command: /\b(?:gcc|g\+\+|clang|clang\+\+)\b/,
    output: /^\S+:\d+:\d+: (?:fatal )?error: /m,
  },
];

export function findSummarizer(command, output) {
  return SUMMARIZERS.find((summarizer) => summarizer.command.test(command))
    ?? SUMMARIZERS.find((summarizer) => summarizer.output.test(output))
    ?? null;
}
