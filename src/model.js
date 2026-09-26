import { setTimeout as sleep } from "node:timers/promises";
import { parseStream } from "./stream.js";
import { CONFIG } from "./config.js";
import { isQuotaError, quotaMessage } from "./model/errors.js";

const MAX_RETRIES = CONFIG.retries.maxRetries;
const MAX_STALL_RETRIES = CONFIG.retries.maxStallRetries;
const STALL_TIMEOUT_MS = CONFIG.timeouts.streamStallSeconds * 1000;
const BASE_BACKOFF_MS = CONFIG.retries.baseBackoffMs;
const MAX_RETRY_AFTER_MS = CONFIG.retries.maxRetryAfterMs;

export async function requestCompletion(request) {
  const attempts = { retries: 0, stallRetries: 0 };
  while (true) {
    try {
      return await attemptCompletion(request);
    } catch (error) {
      if (request.signal.aborted || !takeRetry(error, attempts)) throw error;
      const delayMs = retryDelayMs(error, attempts.retries);
      request.onRetry(`${error.message}; retrying in ${(delayMs / 1000).toFixed(1)}s`);
      await sleep(delayMs, undefined, { signal: request.signal });
    }
  }
}

function takeRetry(error, attempts) {
  if (error.stalled) {
    attempts.stallRetries++;
    return attempts.stallRetries <= MAX_STALL_RETRIES;
  }
  if (!error.retryable) return false;
  attempts.retries++;
  return attempts.retries <= MAX_RETRIES;
}

function retryDelayMs(error, retries) {
  if (error.stalled) return 0;
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS);
  return BASE_BACKOFF_MS * 2 ** (retries - 1);
}

async function attemptCompletion({ config, messages, tools, extra, handlers, signal }) {
  const watchdog = new StallWatchdog(STALL_TIMEOUT_MS);
  try {
    const requestSignal = AbortSignal.any([signal, watchdog.signal]);
    const response = await sendRequest(config, messages, tools, extra, requestSignal);
    return await parseStream(response.body, { ...handlers, onData: () => watchdog.reset() });
  } catch (error) {
    throw describeFailure(error, watchdog.stalled, signal);
  } finally {
    watchdog.stop();
  }
}

async function sendRequest(config, messages, tools, extra, signal) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(buildRequestBody(config, messages, tools, extra)),
    signal,
  });
  if (response.ok) return response;
  throw await createHttpError(response);
}

function buildRequestBody(config, messages, tools, extra) {
  const body = {
    model: config.model,
    messages,
    tools,
    temperature: config.temperature,
    top_p: config.topP,
    max_tokens: config.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (config.seed !== null) body.seed = config.seed;
  return { ...body, ...extra };
}

async function createHttpError(response) {
  const body = await response.text().catch(() => "");
  if (isQuotaError(response.status, body)) return Object.assign(new Error(quotaMessage(response.status, body)), { retryable: false });
  const error = new Error(`API error ${response.status}: ${body.slice(0, 300)}`);
  error.retryable = response.status === 429 || response.status >= 500;
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
  return error;
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function describeFailure(error, stalled, userSignal) {
  if (userSignal.aborted) return error;
  if (stalled) return Object.assign(new Error(`the model stream was silent for ${STALL_TIMEOUT_MS / 1000}s`), { stalled: true });
  if (error.retryable !== undefined) return error;
  const cause = error.cause?.message ? ` (${error.cause.message})` : "";
  return Object.assign(new Error(`network error: ${error.message}${cause}`), { retryable: true });
}

class StallWatchdog {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.stalled = false;
    this.reset();
  }

  reset() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stalled = true;
      this.controller.abort();
    }, this.timeoutMs);
  }

  stop() {
    clearTimeout(this.timer);
  }
}
