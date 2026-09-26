const SCOPE_PRIORITY = ["project", "harness", "user"];
const CATALOG_HINT = "Skills are step-by-step guides for common kinds of work. When a skill below fits the task, call the skill tool with its name first and follow what it says.";

export function selectCatalogSkills(skills, maxSkills) {
  const byPriority = [];
  for (const scope of SCOPE_PRIORITY) {
    byPriority.push(...skills.filter((skill) => skill.scope === scope && !skill.internal));
  }
  const selected = byPriority.slice(0, maxSkills);
  return selected.sort((first, second) => compareNames(first.name, second.name));
}

export function formatCatalog(skills, maxDescriptionChars) {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}: ${shorten(skill.description, maxDescriptionChars)}`);
  return `${CATALOG_HINT}\n${lines.join("\n")}`;
}

function shorten(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function compareNames(first, second) {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}
