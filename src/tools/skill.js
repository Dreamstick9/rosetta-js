import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_FILES = CONFIG.skills.maxSkillFiles;
const MAX_LISTED_NAMES = 40;
const SKIPPED_ENTRIES = new Set([".git", "node_modules", ".DS_Store"]);

let availableSkills = [];

export function setAvailableSkills(skills) {
  availableSkills = skills;
}

export const skillTool = {
  definition: {
    type: "function",
    function: {
      name: "skill",
      description: "Load a skill by name. Returns its instructions and the other files in its folder, which you can read with read_file. The skills are listed in the system prompt.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name, exactly as listed." } },
        required: ["name"],
      },
    },
  },
  run: loadSkill,
};

async function loadSkill({ name }) {
  const skill = availableSkills.find((candidate) => candidate.name === name.trim());
  if (!skill) throw new Error(describeUnknownSkill(name.trim()));
  const sections = [`Skill: ${skill.name}\nFolder: ${skill.folder}`, skill.body];
  const files = listSkillFiles(skill.folder);
  if (files.length > 0) sections.push(`Other files in the skill folder:\n${files.join("\n")}`);
  return sections.join("\n\n");
}

function describeUnknownSkill(name) {
  const names = availableSkills.map((skill) => skill.name).sort();
  if (names.length === 0) return `unknown skill '${name}'. No skills are installed.`;
  const close = findCloseNames(name, names);
  if (close.length > 0) return `unknown skill '${name}'. Did you mean: ${close.join(", ")}?`;
  return `unknown skill '${name}'. Available skills: ${names.slice(0, MAX_LISTED_NAMES).join(", ")}`;
}

function findCloseNames(name, names) {
  const wanted = squash(name);
  if (!wanted) return [];
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  return names.filter((candidate) => {
    const squashed = squash(candidate);
    if (squashed.includes(wanted) || wanted.includes(squashed)) return true;
    return words.some((word) => squashed.includes(word));
  });
}

function squash(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function listSkillFiles(folder) {
  const files = collectFiles(folder, "").filter((file) => file !== SKILL_FILE);
  if (files.length <= MAX_SKILL_FILES) return files;
  const hidden = files.length - MAX_SKILL_FILES;
  return [...files.slice(0, MAX_SKILL_FILES), `[${hidden} more files]`];
}

function collectFiles(folder, prefix) {
  const files = [];
  const entries = fs.readdirSync(path.join(folder, prefix), { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    if (SKIPPED_ENTRIES.has(entry.name)) continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(folder, relative));
    else files.push(relative);
  }
  return files;
}
