import { WEB } from "./settings.js";

export function listKeyedProviders() {
  const providers = [];
  if (process.env.BRAVE_API_KEY) providers.push({ name: "brave", request: braveRequest, parse: parseBrave });
  if (process.env.TAVILY_API_KEY) providers.push({ name: "tavily", request: tavilyRequest, parse: parseTavily });
  return providers;
}

function braveRequest(query) {
  return {
    url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${WEB.maxResults}`,
    options: { headers: { accept: "application/json", "x-subscription-token": process.env.BRAVE_API_KEY } },
  };
}

function parseBrave(text) {
  const results = JSON.parse(text).web?.results ?? [];
  return results.map((result) => ({ title: result.title, url: result.url, snippet: stripTags(result.description ?? "") }));
}

function tavilyRequest(query) {
  return {
    url: "https://api.tavily.com/search",
    options: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: WEB.maxResults }),
    },
  };
}

function parseTavily(text) {
  const results = JSON.parse(text).results ?? [];
  return results.map((result) => ({ title: result.title, url: result.url, snippet: result.content ?? "" }));
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, "");
}
