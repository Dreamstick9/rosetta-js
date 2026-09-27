export const SLASH_COMMANDS = [
  { name: "model", description: "choose what model to use" },
  { name: "approvals", description: "choose what rosetta is allowed to do (safety policy)" },
  { name: "new", description: "start a new conversation" },
  { name: "compact", description: "compact the conversation to free up context" },
  { name: "undo", description: "restore the previous checkpoint" },
  { name: "resume", description: "continue the saved task in this folder" },
  { name: "best-of", description: "run N attempts in parallel and keep the best: /best-of N task" },
  { name: "diff", description: "show git diff (including untracked files)", whileBusy: true },
  { name: "mention", description: "mention a file", whileBusy: true },
  { name: "status", description: "show current session configuration and token usage", whileBusy: true },
  { name: "cost", description: "show the session cost and token totals", whileBusy: true },
  { name: "check", description: "turn the test check after changes on or off (/check on|off)", whileBusy: true },
  { name: "help", description: "show commands and keyboard shortcuts", whileBusy: true },
  { name: "quit", description: "exit rosetta", whileBusy: true },
  { name: "exit", description: "exit rosetta", whileBusy: true, hidden: true },
];

export function findSlashCommand(name) {
  return SLASH_COMMANDS.find((command) => command.name === name) ?? null;
}

export function filterSlashCommands(query) {
  const visible = SLASH_COMMANDS.filter((command) => !command.hidden || command.name === query);
  const starts = visible.filter((command) => command.name.startsWith(query));
  const contains = visible.filter((command) => !command.name.startsWith(query) && command.name.includes(query));
  return [...starts, ...contains];
}

export function parseSlashInput(text) {
  const match = text.trim().match(/^\/(\S*)\s*(.*)$/s);
  return { name: match[1], argument: match[2].trim() };
}
