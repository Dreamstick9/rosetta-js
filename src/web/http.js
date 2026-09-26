import { assertPublicHost } from "./address.js";
import { findBlockReason } from "./guard.js";
import { USER_AGENT, WEB } from "./settings.js";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 4_000_000;
const RETRY_DELAY_MS = 800;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_HEADERS = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
};

export function parseWebUrl(text) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`invalid URL: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https URLs are allowed: ${text}`);
  url.hash = "";
  return url;
}

export async function fetchWithRetry(url, options = {}) {
  try {
    const response = await safeFetch(url, options);
    if (!RETRYABLE_STATUS.has(response.status)) return response;
  } catch (error) {
    if (error.message.startsWith("blocked") || options.signal?.aborted) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return safeFetch(url, options);
}

async function safeFetch(startUrl, { signal, taskText, method = "GET", headers = {}, body } = {}) {
  let url = parseWebUrl(String(startUrl));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkUrl(url, taskText);
    const response = await fetch(url, {
      method,
      body,
      headers: { ...DEFAULT_HEADERS, ...headers },
      redirect: "manual",
      signal: combineSignals(signal),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return readResponse(url, response);
    url = new URL(location, url);
    if (response.status === 303) method = "GET";
  }
  throw new Error(`too many redirects from ${startUrl}`);
}

async function checkUrl(url, taskText) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`blocked: redirect to ${url.protocol} URL`);
  const reason = findBlockReason(url, taskText);
  if (reason) throw new Error(reason);
  await assertPublicHost(url.hostname);
}

function combineSignals(signal) {
  const timeout = AbortSignal.timeout(WEB.timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readResponse(url, response) {
  const bytes = await readLimitedBody(response);
  return {
    url: url.href,
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bytes: bytes.length,
    text: new TextDecoder().decode(bytes),
  };
}

async function readLimitedBody(response) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= MAX_BODY_BYTES) break;
  }
  return Buffer.concat(chunks);
}
