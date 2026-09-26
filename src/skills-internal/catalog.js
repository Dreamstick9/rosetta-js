import fs from "node:fs";
import path from "node:path";
import { HARNESS_ROOT } from "../config.js";

export const SKILLS_DIRECTORY = path.join(HARNESS_ROOT, "skills");

let cachedSkills = null;

export function loadSkills() {
  cachedSkills ??= readSkillFolders().map(readSkill).filter(Boolean);
  return cachedSkills;
}

function readSkillFolders() {
  try {
    return fs.readdirSync(SKILLS_DIRECTORY, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readSkill(name) {
  const folder = path.join(SKILLS_DIRECTORY, name);
  const skillText = readText(path.join(folder, "SKILL.md"));
  if (!skillText) return null;
  return {
    name,
    folder,
    keywords: readList(skillText, "keywords"),
    markers: readList(skillText, "files"),
    digest: readText(path.join(folder, "DIGEST.md")).trim(),
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readList(skillText, field) {
  const match = skillText.match(new RegExp(`^\\s*${field}: \\[(.*)\\]\\s*$`, "m"));
  if (!match) return [];
  return match[1].split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
}
