import fs from "node:fs";
import path from "node:path";
import { parseSkillFile } from "./frontmatter.js";

const SKILL_FILE = "SKILL.md";
const PROJECT_FOLDERS = [".agents/skills", ".claude/skills", ".rosetta/skills"];
const HOME_FOLDERS = [".claude/skills", ".agents/skills", ".rosetta/skills"];
const HARNESS_FOLDER = "skills";

export function listSkillLocations({ projectRoot, homeFolder, harnessRoot }) {
  const locations = [];
  for (const folder of PROJECT_FOLDERS) locations.push({ folder: path.join(projectRoot, folder), scope: "project" });
  for (const folder of HOME_FOLDERS) locations.push({ folder: path.join(homeFolder, folder), scope: "user" });
  locations.push({ folder: path.join(harnessRoot, HARNESS_FOLDER), scope: "harness" });
  return locations;
}

export function discoverSkills(locations) {
  const skills = [];
  const seenNames = new Set();
  for (const location of locations) {
    for (const skill of readSkillFolder(location)) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
}

function readSkillFolder({ folder, scope }) {
  const skills = [];
  for (const entry of listEntryNames(folder)) {
    const skillFolder = path.join(folder, entry);
    const parsed = parseSkillFile(readText(path.join(skillFolder, SKILL_FILE)));
    if (parsed) skills.push({ ...parsed, folder: skillFolder, scope });
  }
  return skills;
}

function listEntryNames(folder) {
  try {
    return fs.readdirSync(folder).sort();
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
