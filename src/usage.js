const TOKENS_PER_MILLION = 1_000_000;

export function createUsage() {
  return { modelCalls: 0, toolCalls: 0, blockedCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 };
}

export function addModelCall(usage, { inputTokens, cachedTokens, outputTokens }, cost) {
  usage.modelCalls++;
  usage.inputTokens += inputTokens;
  usage.cachedTokens += cachedTokens;
  usage.outputTokens += outputTokens;
  usage.cost += cost;
}

export function readTokenCounts(usage, estimatedInputTokens, estimatedOutputTokens) {
  if (!usage) return { inputTokens: estimatedInputTokens, cachedTokens: 0, outputTokens: estimatedOutputTokens };
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

export function calculateCost(pricing, inputTokens, cachedTokens, outputTokens) {
  const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
  const inputCost = uncachedTokens * pricing.inputPerMTok + cachedTokens * pricing.cachedInputPerMTok;
  const outputCost = outputTokens * pricing.outputPerMTok;
  return (inputCost + outputCost) / TOKENS_PER_MILLION;
}
