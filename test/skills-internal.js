import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG, setProjectRoot } from "../src/config.js";
import { chooseSkills } from "../src/skills-internal/router.js";
import { addSkillNotes } from "../src/skills-internal/index.js";
import { digestOutput } from "../src/digest/index.js";
import { builtinDigest } from "../src/digest/builtin.js";

function makeProject(files) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "rjs-skilltest-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

function pytestLog(failures) {
  const lines = [];
  for (let i = 0; i < failures; i++) {
    lines.push(`______ test_case[${i}] ______`, "    def test_case(i):", ">       assert f(i) == i", `E       assert ${i + 1} == ${i}`, "tests/test_x.py:5: AssertionError");
  }
  for (let i = 0; i < failures; i++) lines.push(`FAILED tests/test_x.py::test_case[${i}] - assert ${i + 1} == ${i}`);
  lines.push(`${failures} failed, 3 passed in 0.12s`);
  return lines.join("\n");
}

function names(skills) {
  return skills.map((skill) => skill.name);
}

setProjectRoot(makeProject({ "pyproject.toml": "[project]\nname='x'\n", "pkg/mod.py": "", "tests/test_x.py": "" }));
assert.deepEqual(names(chooseSkills("Fix the crash with a traceback in pkg.mod when parsing", 2)), ["python-library", "systematic-debugging"]);
assert.deepEqual(names(chooseSkills("Refactor: extract the duplicated helpers into one module", 2)), ["python-library", "large-refactor"]);
assert.deepEqual(names(chooseSkills("Fix the bug", 1)), ["python-library"]);
assert.match(addSkillNotes("Fix the bug", { ...CONFIG, skills: { ...CONFIG.skills, internal: true } }), /Harness notes[\s\S]*\[python-library\]/);
assert.equal(addSkillNotes("Fix the bug", CONFIG), "Fix the bug");

setProjectRoot(makeProject({ "go.mod": "module x\n", "x.go": "package x\n" }));
assert.equal(names(chooseSkills("go test fails after the change", 2))[0], "go");

setProjectRoot(makeProject({ "README.md": "hi\n" }));
assert.deepEqual(names(chooseSkills("Write a haiku", 2)), []);

const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rjs-digest-"));
const digest = digestOutput("python3 -m pytest -q", `${pytestLog(40)}\n[exit code 1]`, outputDirectory);
assert.match(digest, /40 fail/);
assert.match(digest, /\[exit code 1\]\n\[digest of \d+ lines; full output: .*1\.txt/);
assert.ok(digest.split("\n").length <= 43);
assert.equal(digestOutput("ls -la", "a\n".repeat(200), outputDirectory), "a\n".repeat(200));
assert.equal(digestOutput("python3 -m pytest", "short", outputDirectory), "short");
assert.match(builtinDigest("pytest", pytestLog(40)), /^40 failed, 3 passed/);

console.log("skills-internal test OK");
