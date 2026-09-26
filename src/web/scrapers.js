import { decodeEntities } from "./html.js";

export const SCRAPERS = [
  { name: "duckduckgo", request: (query) => page(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`), parse: parseDuckDuckGo },
  { name: "duckduckgo-lite", request: (query) => page(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`), parse: parseDuckDuckGoLite },
  { name: "bing", request: (query) => page(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`), parse: parseBing },
];

function page(url) {
  return { url, options: {} };
}

function parseDuckDuckGo(html) {
  return html.split(/class="result results_links/).slice(1)
    .filter((block) => !block.includes("result--ad"))
    .map((block) => ({
      ...readAnchor(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block)),
      snippet: cleanText(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1]),
    }));
}

function parseDuckDuckGoLite(html) {
  const links = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
  return links.map((link, index) => ({ ...readAnchor(link), snippet: cleanText(snippets[index]?.[1]) }));
}

function parseBing(html) {
  return html.split('<li class="b_algo"').slice(1).map((block) => ({
    ...readAnchor(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block)),
    snippet: cleanText(/<p\b[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1]),
  }));
}

function readAnchor(match) {
  if (!match) return { title: "", url: "" };
  return { title: cleanText(match[2]), url: unwrapRedirect(decodeEntities(match[1])) };
}

function unwrapRedirect(href) {
  const url = new URL(href, "https://duckduckgo.com");
  const target = url.searchParams.get("uddg");
  if (target) return target;
  const bingTarget = url.searchParams.get("u");
  if (url.hostname.endsWith("bing.com") && bingTarget?.startsWith("a1")) return Buffer.from(bingTarget.slice(2), "base64url").toString("utf8");
  return url.href;
}

function cleanText(html = "") {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}
