import os from "node:os";
import { CONFIG, HARNESS_ROOT, PROJECT_ROOT } from "./config.js";
import { readProjectInstructions } from "./skills/instructions.js";
import { discoverSkills, listSkillLocations } from "./skills/discovery.js";
import { formatCatalog, selectCatalogSkills } from "./skills/catalog.js";
import { setAvailableSkills } from "./tools/skill.js";
import { formatLessons, readRecentLessons } from "./lessons.js";

const BASE_PROMPT = `You are a coding agent working in the user's project directory.
Use the tools to inspect, change and test the project. Paths are relative to the project root, or absolute.
Some calls are blocked by a safety policy (writing outside the project and /tmp, git push, credential files, secret variables). When a call is blocked, choose another way.
Use search to find code. Read files before editing them, and prefer edit_file for small changes.
The bash tool runs in one persistent shell, so cd and environment changes carry over between calls.
When the project has tests, run them after making changes.
For a task with several separate steps, keep a plan with the todo tool and give each item a check command (such as its test) when you can; the harness ticks an item when its check passes. A small fix needs no plan.
If the task cannot be done (for example, tests that contradict each other), call give_up with the reason; never special-case or game the tests.
Keep replies short. When you are done, say what you changed.`;

export function buildSessionPrompt() {
  const settings = CONFIG.skills;
  const instructions = readProjectInstructions(PROJECT_ROOT, settings.maxInstructionTokens);
  const skills = discoverSkills(listSkillLocations({ projectRoot: PROJECT_ROOT, homeFolder: os.homedir(), harnessRoot: HARNESS_ROOT }));
  const catalogSkills = selectCatalogSkills(skills, settings.maxCatalogSkills);
  setAvailableSkills(skills);
  const sections = [BASE_PROMPT];
  if (instructions) sections.push(`# Project instructions (from ${instructions.file})\n\n${instructions.text}`);
  if (catalogSkills.length > 0) sections.push(`# Skills\n\n${formatCatalog(catalogSkills, settings.maxDescriptionChars)}`);
  const lessons = readRecentLessons(CONFIG.loop.lessonsInPrefix);
  if (lessons.length > 0) sections.push(`# Lessons from earlier sessions in this project\n\nThese attempts failed; avoid repeating them.\n${formatLessons(lessons, true)}`);
  return {
    message: { role: "system", content: sections.join("\n\n") },
    loaded: {
      instructionsFile: instructions?.file ?? null,
      instructionsTruncated: instructions?.truncated ?? false,
      skills: skills.length,
      catalogSkills: catalogSkills.length,
      lessons: lessons.length,
    },
  };
}

export function describeLoadedContext({ instructionsFile, instructionsTruncated, skills, catalogSkills, lessons }) {
  let instructionsPart = "No project instructions";
  if (instructionsFile) instructionsPart = `Loaded ${instructionsFile}${instructionsTruncated ? " (truncated)" : ""}`;
  const skillsPart = catalogSkills < skills ? `${catalogSkills} of ${skills} skills in the catalog` : `${skills} skills`;
  const lessonsPart = lessons > 0 ? ` · ${lessons} lessons` : "";
  return `${instructionsPart} · ${skillsPart}${lessonsPart}`;
}
