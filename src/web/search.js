import { fetchWithRetry } from "./http.js";
import { findBlockReason } from "./guard.js";
import { listKeyedProviders } from "./providers.js";
import { SCRAPERS } from "./scrapers.js";
import { WEB } from "./settings.js";

const SNIPPET_LENGTH = 300;
export const SEARCH_UNAVAILABLE = "search unavailable; web_fetch the official docs or registry URL directly";
const refusingProviders = new Set();

export async function searchWeb({ query, site, signal, taskText }) {
  const fullQuery = site ? `${query} site:${site}` : query;
  const failures = [];
  let bytes = 0;
  for (const provider of [...listKeyedProviders(), ...SCRAPERS]) {
    if (refusingProviders.has(provider.name)) continue;
    try {
      const { url, options } = provider.request(fullQuery);
      const response = await fetchWithRetry(url, { ...options, signal });
      bytes += response.bytes;
      if (response.status !== 200) {
        refusingProviders.add(provider.name);
        throw new Error(`HTTP ${response.status}`);
      }
      const results = keepUsable(provider.parse(response.text), taskText);
      if (results.length > 0) return { provider: provider.name, results, bytes, failures };
      failures.push(`${provider.name}: no results`);
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`${provider.name}: ${error.message}`);
    }
  }
  return { provider: null, results: [], bytes, failures };
}

function keepUsable(results, taskText) {
  const seen = new Set();
  const usable = [];
  for (const result of results) {
    if (!isAllowed(result.url, taskText) || seen.has(result.url)) continue;
    seen.add(result.url);
    usable.push(result);
    if (usable.length === WEB.maxResults) break;
  }
  return usable;
}

function isAllowed(text, taskText) {
  try {
    const url = new URL(text);
    return url.protocol.startsWith("http") && !findBlockReason(url, taskText);
  } catch {
    return false;
  }
}

export function formatResults(results) {
  return results.map((result, index) => {
    const snippet = result.snippet.length > SNIPPET_LENGTH ? `${result.snippet.slice(0, SNIPPET_LENGTH)}…` : result.snippet;
    return `${index + 1}. ${result.title}\n   ${result.url}\n   ${snippet}`;
  }).join("\n");
}
