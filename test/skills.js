import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseSkillFile } from "../src/skills/frontmatter.js";
import { discoverSkills, listSkillLocations } from "../src/skills/discovery.js";
import { formatCatalog, selectCatalogSkills } from "../src/skills/catalog.js";
import { capToTokens, readProjectInstructions } from "../src/skills/instructions.js";
import { estimateTokens } from "../src/context.js";

const FRONT_MATTER_CASES = [
  ["plain", "---\nname: plain\ndescription: Does a thing.\n---\n# Body\n", { name: "plain", description: "Does a thing.", body: "# Body" }],
  ["double quoted", '---\nname: "quoted"\ndescription: "Say \\"hi\\": now"\n---\nx', { name: "quoted", description: 'Say "hi": now', body: "x" }],
  ["single quoted", "---\nname: 'single'\ndescription: 'It''s fine'\n---\n", { name: "single", description: "It's fine", body: "" }],
  ["folded", "---\nname: folded\ndescription: >\n  First line\n  second line.\nother: 1\n---\nbody", { name: "folded", description: "First line second line.", body: "body" }],
  ["plain multi-line", "---\nname: multi\ndescription: Starts here\n  and goes on.\n---\n", { name: "multi", description: "Starts here and goes on.", body: "" }],
];
const INVALID_FILES = ["no front matter", "---\nname: x\n", "---\nname: x\n---\n", "---\ndescription: y\n---\n", "---\nname: two words\ndescription: y\n---\n"];

const checks = [];

function check(label, run) {
  checks.push({ label, run });
}

function writeSkill(root, folder, name, description) {
  fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${folder}\n`);
}

function createTree() {
  const root = fs.mkdtempSync("/tmp/rjs-skills-test-");
  const folders = { projectRoot: path.join(root, "repo"), homeFolder: path.join(root, "home"), harnessRoot: path.join(root, "harness") };
  writeSkill(folders.projectRoot, ".claude/skills/shared", "shared", "from project claude");
  writeSkill(folders.projectRoot, ".agents/skills/local", "local", "from project agents");
  writeSkill(folders.homeFolder, ".claude/skills/shared-copy", "shared", "from home");
  writeSkill(folders.homeFolder, ".agents/skills/zeta", "zeta", "from home agents");
  writeSkill(folders.harnessRoot, "skills/bug-fix", "bug-fix", "from harness");
  writeSkill(folders.harnessRoot, "skills/local", "local", "harness copy");
  fs.mkdirSync(path.join(folders.homeFolder, ".agents/skills/broken"), { recursive: true });
  fs.writeFileSync(path.join(folders.homeFolder, ".agents/skills/broken/SKILL.md"), "no front matter");
  return { root, folders };
}

for (const [label, text, expected] of FRONT_MATTER_CASES) {
  check(`parses ${label} front matter`, () => assert.deepEqual(parseSkillFile(text), expected));
}

check("rejects invalid skill files", () => {
  for (const text of INVALID_FILES) assert.equal(parseSkillFile(text), null, JSON.stringify(text));
});

check("discovers skills in order and the first name wins", () => {
  const { root, folders } = createTree();
  const skills = discoverSkills(listSkillLocations(folders));
  fs.rmSync(root, { recursive: true, force: true });
  const summary = skills.map((skill) => `${skill.name}:${skill.description}:${skill.scope}`);
  assert.deepEqual(summary, ["local:from project agents:project", "shared:from project claude:project", "zeta:from home agents:user", "bug-fix:from harness:harness"]);
});

check("the catalog is sorted, capped, and keeps project and harness skills first", () => {
  const skills = ["d", "a", "c", "b"].map((name) => ({ name, description: `about ${name}`, scope: "user" }));
  skills.push({ name: "z-harness", description: "h", scope: "harness" }, { name: "y-project", description: "p", scope: "project" });
  const names = selectCatalogSkills(skills, 4).map((skill) => skill.name);
  assert.deepEqual(names, ["a", "d", "y-project", "z-harness"]);
});

check("the catalog cuts long descriptions", () => {
  const text = formatCatalog([{ name: "long", description: "x".repeat(300) }], 150);
  const line = text.split("\n").at(-1);
  assert.equal(line.length, "- long: ".length + 150);
  assert.ok(line.endsWith("…"));
  assert.equal(formatCatalog([], 150), "");
});

check("project instructions use the first file found and are capped", () => {
  const root = fs.mkdtempSync("/tmp/rjs-instructions-test-");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "claude rules");
  assert.deepEqual(readProjectInstructions(root, 100), { file: "CLAUDE.md", text: "claude rules", truncated: false });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "line of agent rules\n".repeat(500));
  const instructions = readProjectInstructions(root, 100);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(instructions.file, "AGENTS.md");
  assert.ok(instructions.truncated);
  assert.ok(instructions.text.endsWith("\n[truncated]"));
  assert.ok(estimateTokens(instructions.text) <= 100);
  assert.equal(capToTokens("short", 100), "short");
});

function main() {
  const failures = [];
  for (const { label, run } of checks) {
    try {
      run();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL skills: ${failure}`);
    process.exit(1);
  }
  console.log(`PASS skills: ${checks.length} checks.`);
}

main();
