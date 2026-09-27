import { chooseSkills } from "./router.js";
import { describeProject } from "./detect.js";
import { writeDimLine } from "../ui.js";

export function addSkillNotes(taskText, config) {
  if (!config.skills.internal) return taskText;
  const skills = chooseSkills(taskText, config.skills.maxAuto).filter((skill) => skill.digest);
  if (skills.length === 0) return taskText;
  writeDimLine(`📖 skill: ${skills.map((skill) => skill.name).join(", ")}`);
  const sections = skills.map((skill) => `[${skill.name}] (full guide: skill tool, name "${skill.name}")\n${skill.digest}`);
  const projectScan = config.skills.detect ? describeProject(skills) : null;
  if (projectScan) sections.push(projectScan);
  return `${taskText}\n\n---\nHarness notes (guides picked for this task):\n${sections.join("\n")}`;
}
