import { sanitize, span, style, textWidth, wrapSpans } from "./text.js";

const FENCE_PATTERN = /^\s*(```|~~~)/;
const RULE_PATTERN = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const QUOTE_PATTERN = /^\s*>\s?(.*)$/;
const ITEM_PATTERN = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g;
const LINK_PATTERN = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

export class MarkdownStream {
  constructor() {
    this.inFence = false;
  }

  renderLine(text, width, firstPrefix, restPrefix) {
    if (FENCE_PATTERN.test(text)) {
      this.inFence = !this.inFence;
      return [];
    }
    return renderMarkdownLine(text, this.inFence, width, firstPrefix, restPrefix);
  }

  previewLine(text, width, firstPrefix, restPrefix) {
    if (FENCE_PATTERN.test(text)) return [];
    return renderMarkdownLine(text, this.inFence, width, firstPrefix, restPrefix);
  }
}

function renderMarkdownLine(rawText, inFence, width, firstPrefix, restPrefix) {
  const text = sanitize(rawText);
  if (inFence) return wrapSpans([span(text)], width, firstPrefix, restPrefix);
  const heading = text.match(HEADING_PATTERN);
  if (heading) return wrapSpans(parseInline(heading[2], heading[1].length === 1 ? style("bold", "underline") : style("bold")), width, firstPrefix, restPrefix);
  if (RULE_PATTERN.test(text)) return [[...firstPrefix, span("─".repeat(Math.max(3, Math.min(width - 4, 40))), style("dim"))]];
  const quote = text.match(QUOTE_PATTERN);
  if (quote) {
    const bar = span("▌ ", style("green"));
    return wrapSpans(parseInline(quote[1], style("dim")), width, [...firstPrefix, bar], [...restPrefix, bar]);
  }
  const item = text.match(ITEM_PATTERN);
  if (item) {
    const marker = `${item[2]} `;
    const hanging = span(" ".repeat(textWidth(item[1] + marker)));
    return wrapSpans(parseInline(item[3]), width, [...firstPrefix, span(item[1]), span(marker, style("dim"))], [...restPrefix, hanging]);
  }
  return wrapSpans(parseInline(text), width, firstPrefix, restPrefix);
}

export function parseInline(text, base = "") {
  const spans = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) spans.push(span(text.slice(last, match.index), base));
    spans.push(...inlineSpans(match[0], base));
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push(span(text.slice(last), base));
  return spans;
}

function inlineSpans(token, base) {
  const join = (...codes) => codes.filter(Boolean).join(";");
  if (token.startsWith("`")) return [span(token.slice(1, -1), join(base, style("cyan")))];
  if (token.startsWith("**") || token.startsWith("__")) return [span(token.slice(2, -2), join(base, style("bold")))];
  const link = token.match(LINK_PATTERN);
  if (link) {
    const label = span(link[1], join(base, style("cyan", "underline")));
    return link[1] === link[2] ? [label] : [label, span(` (${link[2]})`, join(base, style("dim")))];
  }
  return [span(token.slice(1, -1), join(base, style("italic")))];
}
