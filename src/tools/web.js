import { fetchPage } from "../web/fetch.js";
import { SEARCH_UNAVAILABLE, formatResults, searchWeb } from "../web/search.js";
import { WEB } from "../web/settings.js";

const QUERY_LENGTH = 60;
const PATH_LENGTH = 60;

const webSearchTool = {
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description: `Search the web. Returns at most ${WEB.maxResults} results (title, url, snippet).`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search words, e.g. an exact error message or 'library function docs'." },
          site: { type: "string", description: "Optional domain to search within, e.g. docs.python.org." },
        },
        required: ["query"],
      },
    },
  },
  run: webSearch,
};

const webFetchTool = {
  definition: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL as plain text. Large JSON becomes a key outline plus the values whose keys match prompt. PyPI, npm, crates.io and GitHub releases pages return version summaries. Long pages come in parts.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL." },
          prompt: { type: "string", description: "Optional words for what you need; picks JSON keys and names the parts that mention them." },
          part: { type: "integer", description: "Part number of a long page (default 1)." },
        },
        required: ["url"],
      },
    },
  },
  run: webFetch,
};

export const WEB_TOOLS = WEB.enabled ? [webSearchTool, webFetchTool] : [];
export const WEB_PROMPT_LINE = WEB.enabled ? "Use web_search and web_fetch only when the project and your own knowledge are not enough (unfamiliar errors, recent versions, changelogs); prefer official docs and package registries.\n" : "";

async function webSearch({ query, site }, context) {
  const startedAt = Date.now();
  const search = await searchWeb({ query, site, signal: context.signal, taskText: context.taskText });
  const urls = search.results.map((result) => result.url);
  traceWeb(context, { action: "search", query, site, provider: search.provider, urls, bytes: search.bytes, ms: Date.now() - startedAt, failures: search.failures });
  const line = `🌐 search "${shorten(query, QUERY_LENGTH)}" → ${search.results.length} results`;
  return { output: search.results.length > 0 ? formatResults(search.results) : SEARCH_UNAVAILABLE, line };
}

async function webFetch({ url, prompt, part }, context) {
  const startedAt = Date.now();
  try {
    const page = await fetchPage({ url, prompt, part, signal: context.signal, taskText: context.taskText });
    traceWeb(context, { action: "fetch", url: page.url, prompt, bytes: page.bytes, cached: page.cached, part: page.number, parts: page.total, ms: Date.now() - startedAt });
    const line = `🌐 fetch ${describeUrl(page.url)} (${Math.max(1, Math.round(page.bytes / 1024))} KB, part ${page.number}/${page.total})`;
    return { output: page.text, line };
  } catch (error) {
    traceWeb(context, { action: "fetch", url, error: error.message, ms: Date.now() - startedAt });
    throw error;
  }
}

function traceWeb(context, entry) {
  context.trace?.write({ type: "web", ...entry });
}

function describeUrl(text) {
  const url = new URL(text);
  return `${url.hostname}${shorten(url.pathname, PATH_LENGTH)}`;
}

function shorten(text, length) {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}
