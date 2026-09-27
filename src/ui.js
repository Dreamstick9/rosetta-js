const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const USE_COLOR = process.stdout.isTTY;
const TOOL_MARKS = { ok: "→", error: "✗", blocked: "⊘" };
const DETAIL_LENGTH = 120;

let atLineStart = true;
let sink = null;

export function setUiSink(nextSink) {
  sink = nextSink;
}

export function writeText(text) {
  if (!text) return;
  if (sink) return sink.text(text);
  process.stdout.write(text);
  atLineStart = text.endsWith("\n");
}

export function writeLine(text) {
  if (sink) return sink.notice(text, "plain");
  const prefix = atLineStart ? "" : "\n";
  writeText(`${prefix}${text}\n`);
}

export function writeDimLine(text) {
  if (sink) return sink.notice(text, "dim");
  writeLine(paint(DIM, text));
}

export function writeError(text) {
  if (sink) return sink.notice(text, "error");
  writeLine(paint(RED, text));
}

function paint(color, text) {
  if (!USE_COLOR) return text;
  return `${color}${text}${RESET}`;
}

export function createReplyPrinter() {
  if (sink) return { onText: (text) => sink.text(text), onReasoning: (text) => sink.reasoning(text) };
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

export function writeToolStart(call) {
  sink?.toolStart(call);
}

export function writeToolLine(result) {
  if (sink) return sink.toolEnd(result);
  const { name, summary, status, output } = result;
  const parts = [`  ${TOOL_MARKS[status]} ${name}`];
  if (summary) parts.push(summary);
  if (status !== "ok") parts.push(`— ${firstLine(output)}`);
  writeDimLine(parts.join(" "));
}

function firstLine(text) {
  return text.split("\n")[0].slice(0, DETAIL_LENGTH);
}

export function writeCheckStart(command) {
  sink?.checkStart(command);
}

export function writeCheckResult({ command, passed }) {
  if (sink) return sink.checkEnd({ command, passed });
  writeDimLine(`check: ${command} ${passed ? "✓" : "✗"}`);
}

export function writeInterrupted() {
  if (sink) return sink.interrupted();
  writeDimLine("[interrupted]");
}

export function writeFooter(result) {
  if (sink) return sink.taskEnd(result);
  const { cost, seconds, inputTokens, cachedTokens, outputTokens } = result;
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
