import { firstLines, runSkillScript } from "./run-script.js";

const MAX_DETECT_LINES = 12;
const DETECT_SCRIPTS = {
  "rust": "crate_map.py",
  "go": "go_map.py",
  "c-cpp": "cc_build_detect.py",
  "java-kotlin": "jvm_detect.py",
  "backend-api": "detect_backend.py",
  "web-frontend": "detect_frontend.py",
  "node-typescript": "pkg_info.py",
  "shell-scripting": "sh_map.py",
  "databases-sql": "schema_summary.py",
  "dependency-upgrade": "pins_list.py",
};

export function describeProject(skills) {
  const skill = skills.find((candidate) => DETECT_SCRIPTS[candidate.name]);
  if (!skill) return null;
  const script = DETECT_SCRIPTS[skill.name];
  const output = runSkillScript(skill.name, script, []);
  if (!output) return null;
  return `Project scan (${script}):\n${firstLines(output, MAX_DETECT_LINES)}`;
}
