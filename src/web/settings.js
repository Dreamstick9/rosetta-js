import { CONFIG } from "../config.js";

export const WEB = {
  enabled: CONFIG.web.enabled,
  maxFetchParts: CONFIG.web.maxFetchParts,
  excludedDomains: CONFIG.web.excludedDomains,
  jsonDigest: CONFIG.web.jsonDigest,
  timeoutMs: CONFIG.web.timeoutSeconds * 1000,
  partBytes: Math.min(24_000, CONFIG.context.maxToolOutputBytes - 1000),
  jsonDigestBytes: 12_000,
  maxResults: 6,
};

export const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
