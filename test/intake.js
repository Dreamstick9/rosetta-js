import { buildTaskMessage } from "../src/intake/message.js";
import { parseTaskReference } from "../src/intake/parse.js";
import { buildGitEnvironment, hideToken } from "../src/intake/token.js";

const FAKE_TOKEN = "ghp_FAKE0123456789abcdefFAKE0123456789ab";
const PARSE_CASES = [
  ["https://github.com/octo/hello/issues/12", { owner: "octo", repo: "hello", kind: "issue", number: 12, rest: "" }],
  ["Please fix https://github.com/octo/hello/issues/7#issuecomment-1.", { owner: "octo", repo: "hello", kind: "issue", number: 7, rest: "Please fix ." }],
  ["https://github.com/octo/hello/pull/3", { owner: "octo", repo: "hello", kind: "pull", number: 3, rest: "" }],
  ["Look at https://github.com/octo/hello.git and add a test", { owner: "octo", repo: "hello", kind: null, number: null, rest: "Look at and add a test" }],
  ["https://github.com/octo/hello.js/", { owner: "octo", repo: "hello.js", kind: null, number: null, rest: "" }],
  ["Repository: octo/hello\nAdd a README.", { owner: "octo", repo: "hello", kind: null, number: null, rest: "Add a README." }],
  ["Repository: https://github.com/octo/hello\nFix it.", { owner: "octo", repo: "hello", kind: null, number: null, rest: "Fix it." }],
  ["Repository: octo/hello\nSee https://github.com/other/thing/issues/5", { owner: "other", repo: "thing", kind: "issue", number: 5, rest: "Repository: octo/hello\nSee" }],
  ["Fix the bug in math.js", null],
  ["https://github.com/octo", null],
  ["Repository: not a repo", null],
  ["https://gitlab.com/octo/hello/issues/1", null],
];

function main() {
  const failures = [...PARSE_CASES.map(checkParse), checkMessage(), ...checkTokenHandling()].filter(Boolean);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL intake: ${failure}`);
    process.exit(1);
  }
  console.log(`PASS intake: ${PARSE_CASES.length} parse cases, the task message and token hiding.`);
}

function checkParse([text, expected]) {
  const actual = parseTaskReference(text);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return null;
  return `${JSON.stringify(text)} gave ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

function checkMessage() {
  const reference = parseTaskReference("https://github.com/octo/hello/issues/12\nKeep it small.");
  const issue = { title: "Crash", body: "It crashes.", comments: [{ author: "ann", text: "Me too." }], hiddenComments: 0 };
  const message = buildTaskMessage({ reference, folderNote: "cloned at /tmp/x", issue });
  const expected = "Repository: octo/hello (cloned at /tmp/x)\nIssue #12: Crash\n\nIt crashes.\n\nComments:\n- ann: Me too.\n\nKeep it small.";
  if (message === expected) return null;
  return `task message was ${JSON.stringify(message)}`;
}

function checkTokenHandling() {
  const failures = [];
  const environment = buildGitEnvironment(FAKE_TOKEN);
  if (JSON.stringify(environment).includes(FAKE_TOKEN)) failures.push("the git environment holds the raw token");
  if (environment.GIT_TERMINAL_PROMPT !== "0") failures.push("git may prompt");
  const hidden = hideToken(`bad ${FAKE_TOKEN} and ${environment.GIT_CONFIG_VALUE_1}`, FAKE_TOKEN);
  if (hidden.includes(FAKE_TOKEN) || hidden.includes(environment.GIT_CONFIG_VALUE_1.split(" ").at(-1))) failures.push(`token not hidden: ${hidden}`);
  return failures;
}

main();
