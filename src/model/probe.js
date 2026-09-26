import { readCachedProbe, writeCachedProbe } from "./probe-cache.js";
import { extractTextCalls } from "./extract.js";
import { REASONING_FIELDS } from "./reasoning.js";

const PROBE_VERSION = 1;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_TOKENS = 512;
const MAX_ATTEMPTS = 3;
const FAMILIES = [
  ["deepseek", /deepseek/i], ["qwen", /qwen|qwq/i], ["gpt-oss", /gpt-oss/i], ["llama", /llama/i],
  ["kimi", /kimi|moonshot/i], ["glm", /glm|z-ai|zhipu/i], ["mistral", /mistral|devstral|codestral|magistral/i],
];
const PING_TOOL = {
  type: "function",
  function: { name: "ping", description: "Checks the connection.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
};
const TOOL_PROMPT = 'Call the ping tool with text "ok". Do not answer in plain text.';
const TEXT_PROMPT = 'Reply with exactly: <tool_call>{"name": "ping", "arguments": {"text": "ok"}}</tool_call>';

export function detectFamily(modelId) {
  return FAMILIES.find(([, pattern]) => pattern.test(modelId))?.[0] ?? "other";
}

export async function probeModel(config) {
  const key = `v${PROBE_VERSION} ${config.baseUrl} ${config.model}`;
  const cached = readCachedProbe(key);
  if (cached) return { ...cached, cached: true };
  const [info, chat] = await Promise.all([fetchModelInfo(config), probeChat(config)]);
  const profile = { family: detectFamily(config.model), ...chat.profile, contextWindow: info.contextWindow ?? null };
  if (info.parameters && !info.parameters.some((name) => /reasoning/.test(name))) profile.effortAccepted = false;
  if (chat.clean) writeCachedProbe(key, profile);
  return { ...profile, cached: false, problem: chat.problem ?? null };
}

async function fetchModelInfo(config) {
  try {
    const response = await fetch(`${apiBase(config)}/models`, { headers: authHeaders(config), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const list = await response.json();
    const entry = (list.data ?? list).find?.((model) => model.id === config.model);
    if (!entry) return {};
    const contextWindow = entry.context_length ?? entry.max_model_len ?? entry.context_window ?? entry.top_provider?.context_length;
    return { contextWindow, parameters: entry.supported_parameters };
  } catch {
    return {};
  }
}

async function probeChat(config) {
  const options = { tools: true, effort: true };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await postProbe(config, options);
    if (result.json) return analyze(result.json, options);
    if (!result.status || result.status === 429 || result.status >= 500) break;
    if (options.effort && /reason|effort/i.test(result.text)) options.effort = false;
    else if (options.tools) options.tools = false;
    else break;
  }
  return { clean: false, problem: "probe request failed", profile: { nativeTools: true, reasoningField: null, cacheField: null, effortAccepted: false } };
}

async function postProbe(config, options) {
  const body = { model: config.model, max_tokens: PROBE_MAX_TOKENS, temperature: 0 };
  body.messages = [{ role: "user", content: options.tools ? TOOL_PROMPT : TEXT_PROMPT }];
  if (options.tools) body.tools = [PING_TOOL];
  if (options.effort) body.reasoning_effort = "low";
  try {
    const response = await fetch(`${apiBase(config)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(config) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    return response.ok ? { json: JSON.parse(text) } : { status: response.status, text };
  } catch (error) {
    return { status: 0, text: error.message };
  }
}

function analyze(json, options) {
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = message.content ?? "";
  const nativeCall = options.tools && (message.tool_calls?.length ?? 0) > 0;
  const textCall = extractTextCalls(content, (name) => name === "ping").calls.length > 0;
  const decided = nativeCall || textCall || choice.finish_reason !== "length";
  return {
    clean: decided,
    problem: decided ? null : "probe reply was cut off",
    profile: {
      nativeTools: options.tools && (nativeCall || !textCall),
      reasoningField: findReasoningField(message, content),
      cacheField: findCacheField(json.usage),
      effortAccepted: options.effort,
    },
  };
}

function findReasoningField(message, content) {
  const field = REASONING_FIELDS.find((name) => message[name] && message[name].length > 0);
  if (field) return field;
  return /<think>/.test(content) ? "think-tags" : null;
}

function findCacheField(usage) {
  if (usage?.prompt_tokens_details && "cached_tokens" in usage.prompt_tokens_details) return "prompt_tokens_details.cached_tokens";
  if (usage && "prompt_cache_hit_tokens" in usage) return "prompt_cache_hit_tokens";
  return null;
}

function apiBase(config) {
  return config.baseUrl.replace(/\/$/, "");
}

function authHeaders(config) {
  return { authorization: `Bearer ${config.apiKey}` };
}
