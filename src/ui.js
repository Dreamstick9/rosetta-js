const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const USE_COLOR = process.stdout.isTTY;
const TOOL_MARKS = { ok: "→", error: "✗" };
const DETAIL_LENGTH = 120;

let atLineStart = true;

export function writeText(text) {
  if (!text) return;
  process.stdout.write(text);
  atLineStart = text.endsWith("\n");
}

export function writeLine(text) {
  const prefix = atLineStart ? "" : "\n";
  writeText(`${prefix}${text}\n`);
}

export function writeDimLine(text) {
  writeLine(paint(DIM, text));
}

export function writeError(text) {
  writeLine(paint(RED, text));
}

function paint(color, text) {
  if (!USE_COLOR) return text;
  return `${color}${text}${RESET}`;
}

export function createReplyPrinter() {
  let thinkingShown = false;
  return {
    onText: writeText,
    onReasoning() {
      if (thinkingShown) return;
      thinkingShown = true;
      writeDimLine("thinking…");
    },
  };
}

export function writeToolLine({ name, summary, status, output }) {
  const parts = [`  ${TOOL_MARKS[status]} ${name}`];
  if (summary) parts.push(summary);
  if (status !== "ok") parts.push(`— ${firstLine(output)}`);
  writeDimLine(parts.join(" "));
}

function firstLine(text) {
  return text.split("\n")[0].slice(0, DETAIL_LENGTH);
}

export function writeFooter({ cost, seconds, inputTokens, cachedTokens, outputTokens }) {
  const parts = [
    `$${cost.toFixed(4)}`,
    `${seconds.toFixed(1)}s`,
    `cache ${cachePercent(cachedTokens, inputTokens)}%`,
    `in ${inputTokens}`,
    `out ${outputTokens}`,
  ];
  writeDimLine(parts.join(" · "));
}

export function writeCostSummary(totals, traceFile) {
  const lines = [
    `Session cost: $${totals.cost.toFixed(4)}`,
    `Model calls: ${totals.modelCalls} · tool calls: ${totals.toolCalls}`,
    `Tokens: in ${totals.inputTokens} · cached ${totals.cachedTokens} (${cachePercent(totals.cachedTokens, totals.inputTokens)}%) · out ${totals.outputTokens}`,
    `Trace: ${traceFile ?? "(nothing recorded yet)"}`,
  ];
  writeLine(lines.join("\n"));
}

function cachePercent(cachedTokens, inputTokens) {
  if (inputTokens === 0) return 0;
  return Math.round((cachedTokens / inputTokens) * 100);
}
