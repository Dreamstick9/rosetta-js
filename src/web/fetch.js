import { findBlockReason } from "./guard.js";
import { htmlToText } from "./html.js";
import { fetchWithRetry, parseWebUrl } from "./http.js";
import { digestJson, parseJson, promptWords } from "./json.js";
import { findFastPath, rewriteToRaw } from "./registry.js";
import { splitParts } from "./parts.js";
import { WEB } from "./settings.js";

const BINARY_TYPES = /^(image|audio|video|font)\/|application\/(pdf|zip|gzip|octet-stream|x-tar)/;
const pageCache = new Map();

export async function fetchPage({ url: text, prompt = "", part = 1, signal, taskText }) {
  const url = rewriteToRaw(parseWebUrl(text));
  const reason = findBlockReason(url, taskText);
  if (reason) throw new Error(reason);
  const cached = pageCache.has(url.href);
  if (!cached) pageCache.set(url.href, await loadPage(url, signal, taskText));
  const page = pageCache.get(url.href);
  const parts = splitParts(renderPage(page, prompt), WEB.partBytes);
  const total = Math.min(parts.length, WEB.maxFetchParts);
  const number = Math.min(Math.max(1, Math.floor(Number(part)) || 1), total);
  return { url: page.url, bytes: page.bytes, cached, number, total, text: formatPart(page.url, parts, number, total, prompt) };
}

async function loadPage(url, signal, taskText) {
  const fastPath = findFastPath(url);
  if (fastPath) {
    try {
      return await loadFastPath(url, fastPath, signal, taskText);
    } catch (error) {
      if (signal?.aborted || error.message.startsWith("blocked")) throw error;
    }
  }
  const response = await fetchWithRetry(url, { signal, taskText });
  if (response.status >= 400) throw new Error(`HTTP ${response.status} from ${response.url}${shortBody(response.text)}`);
  return { url: response.url, bytes: response.bytes, ...readBody(response) };
}

async function loadFastPath(url, fastPath, signal, taskText) {
  const bodies = [];
  let bytes = 0;
  for (const request of fastPath.requests) {
    const response = await fetchWithRetry(request, { signal, taskText, headers: { accept: "application/json" } });
    if (response.status >= 400) throw new Error(`HTTP ${response.status} from ${response.url}${shortBody(response.text)}`);
    bodies.push(JSON.parse(response.text));
    bytes += response.bytes;
  }
  return { url: url.href, bytes, text: fastPath.render(bodies) };
}

function readBody({ contentType, text, url }) {
  if (BINARY_TYPES.test(contentType)) throw new Error(`unsupported content type ${contentType} at ${url}`);
  const json = /json/.test(contentType) || /^\s*[[{]/.test(text) ? parseJson(text) : { ok: false };
  if (json.ok) return { data: json.data, text };
  if (/html|xml/.test(contentType) || /^\s*<(!doctype|html)/i.test(text)) return { text: htmlToText(text, url) };
  return { text };
}

function renderPage(page, prompt) {
  if (page.data === undefined || !WEB.jsonDigest) return page.text;
  return digestJson(page.data, prompt);
}

function formatPart(url, parts, number, total, prompt) {
  const lines = [`URL: ${url}`];
  if (total > 1) lines.push(`[part ${number}/${total}]`);
  lines.push(parts[number - 1]);
  if (number < total) lines.push(`[${total - number} more parts: call web_fetch with part=${number + 1}…${total}]`);
  if (parts.length > WEB.maxFetchParts && number === total) lines.push(`[page truncated after part ${total}]`);
  if (total > 1) lines.push(...describeMatches(parts.slice(0, total), prompt));
  return lines.join("\n");
}

function describeMatches(parts, prompt) {
  const words = promptWords(prompt);
  if (words.length === 0) return [];
  const counts = parts.map((part, index) => ({ number: index + 1, hits: countHits(part.toLowerCase(), words) }));
  const ranked = counts.filter((count) => count.hits > 0).sort((a, b) => b.hits - a.hits);
  if (ranked.length === 0) return [`[no part mentions: ${words.join(", ")}]`];
  return [`[parts mentioning ${words.join(", ")}: ${ranked.map((count) => `${count.number} (${count.hits})`).join(", ")}]`];
}

function countHits(text, words) {
  return words.reduce((total, word) => total + text.split(word).length - 1, 0);
}

function shortBody(text) {
  const body = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return body && !body.startsWith("<") ? `: ${body}` : "";
}
