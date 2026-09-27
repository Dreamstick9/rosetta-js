const DROPPED_BLOCKS = /<(script|style|noscript|svg|nav|footer|template|iframe|head|button|select)\b[\s\S]*?<\/\1\s*>/gi;
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
const BLOCK_TAGS = /<\/?(p|div|section|article|main|header|aside|table|thead|tbody|tr|ul|ol|dl|dt|dd|blockquote|figure|br|hr)\b[^>]*>/gi;
const CODE_MARK = "\u0000code";
const LONE_MARKS = /^[|»·•¶-]$/;

export function htmlToText(html, baseUrl) {
  const title = readTitle(html);
  const codeBlocks = [];
  let text = pickMainContent(html.replace(/<!--[\s\S]*?-->/g, "").replace(DROPPED_BLOCKS, ""));
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => keepCode(codeBlocks, inner));
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n\n${"#".repeat(level)} ${inlineText(inner)}\n\n`);
  text = text.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => formatLink(href, inner, baseUrl));
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${stripTags(inner)}\``);
  text = text.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/t[dh]>/gi, " | ").replace(BLOCK_TAGS, "\n");
  text = decodeEntities(stripTags(text));
  text = tidyLines(text).replace(/\u0000code(\d+)/g, (_, index) => codeBlocks[index]);
  return title ? `Title: ${title}\n\n${text}` : text;
}

function readTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? inlineText(match[1]) : "";
}

function pickMainContent(html) {
  for (const tag of ["main", "article", "body"]) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}>`, "i").exec(html);
    if (match && match[1].trim().length > 200) return match[1];
  }
  return html;
}

function keepCode(codeBlocks, inner) {
  const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/\n+$/, "");
  codeBlocks.push(`\n\`\`\`\n${code}\n\`\`\`\n`);
  return `\n${CODE_MARK}${codeBlocks.length - 1}\n`;
}

function formatLink(href, inner, baseUrl) {
  const label = inlineText(inner);
  if (!label) return "";
  const target = resolveHref(decodeEntities(href), baseUrl);
  if (!target || target === label) return label;
  return `[${label}](${target})`;
}

function resolveHref(href, baseUrl) {
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return null;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol.startsWith("http") ? url.href : null;
  } catch {
    return null;
  }
}

function inlineText(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === "#") return decodeCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)), entity);
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function decodeCodePoint(codePoint, fallback) {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function tidyLines(text) {
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter((line) => !LONE_MARKS.test(line));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
