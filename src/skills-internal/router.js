import { loadSkills } from "./catalog.js";
import { hasMarker, scanProject } from "./project-scan.js";

const FILE_MARKER_POINTS = 3;
const EXTENSION_MARKER_POINTS = 2;
const MAX_MARKER_POINTS = 6;
const MAX_KEYWORD_POINTS = 4;

const TASK_TYPES = [
  { skill: "dependency-upgrade", weight: 2, words: ["upgrade", "bump", "lockfile", "breaking change", "outdated dependency", "dependency version"] },
  { skill: "debugging-perf", weight: 2, words: ["slow", "slower", "performance", "optimize", "optimise", "speed up", "faster", "memory leak", "profiling", "hangs", "deadlock", "race condition", "flaky", "quadratic"] },
  { skill: "large-refactor", weight: 2, words: ["refactor", "refactoring", "restructure", "extract", "rename", "deduplicate", "duplicated", "duplication", "reorganize", "consolidate", "move the", "split the"] },
  { skill: "systematic-debugging", weight: 1, words: ["bug", "fix", "crash", "crashes", "traceback", "exception", "error", "fails", "failing", "broken", "wrong", "incorrect", "regression", "panic", "segfault", "unexpected"] },
  { skill: "tdd", weight: 1, words: ["implement", "add support", "new feature", "feature request", "add a", "add an", "should support", "allow"] },
];
const METHOD_SKILLS = new Set([...TASK_TYPES.map((type) => type.skill), "verification-before-completion"]);

export function chooseSkills(taskText, maxSkills) {
  const text = taskText.toLowerCase();
  const skills = loadSkills();
  const chosen = [pickDomainSkill(skills, text), pickMethodSkill(text)].filter(Boolean);
  return chosen.slice(0, maxSkills).map((name) => skills.find((skill) => skill.name === name)).filter(Boolean);
}

function pickDomainSkill(skills, text) {
  const scan = scanProject();
  let best = null;
  for (const skill of skills) {
    if (METHOD_SKILLS.has(skill.name)) continue;
    const markerPoints = scoreMarkers(scan, skill.markers);
    if (markerPoints === 0) continue;
    const score = markerPoints + Math.min(MAX_KEYWORD_POINTS, countWords(text, skill.keywords));
    if (!best || score > best.score) best = { name: skill.name, score };
  }
  return best?.name ?? null;
}

function scoreMarkers(scan, markers) {
  let points = 0;
  for (const marker of markers) {
    if (hasMarker(scan, marker)) points += marker.startsWith("*.") ? EXTENSION_MARKER_POINTS : FILE_MARKER_POINTS;
  }
  return Math.min(MAX_MARKER_POINTS, points);
}

function pickMethodSkill(text) {
  let best = null;
  for (const type of TASK_TYPES) {
    const score = countWords(text, type.words) * type.weight;
    if (score > 0 && (!best || score > best.score)) best = { name: type.skill, score };
  }
  return best?.name ?? null;
}

function countWords(text, words) {
  return words.filter((word) => containsWord(text, word.toLowerCase())).length;
}

function containsWord(text, word) {
  let index = text.indexOf(word);
  while (index !== -1) {
    if (isBoundary(text[index - 1]) && isBoundary(text[index + word.length])) return true;
    index = text.indexOf(word, index + 1);
  }
  return false;
}

function isBoundary(character) {
  return character === undefined || !/[a-z0-9_]/.test(character);
}
