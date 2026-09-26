const GITHUB_URL_PATTERN = /https?:\/\/(?:www\.)?github\.com\/\S+/gi;
const REPOSITORY_LINE_PATTERN = /^[ \t]*Repository:[ \t]*(\S+)[ \t]*$/im;
const SHORT_NAME_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>"'`]+$/;
const ITEM_KINDS = { issues: "issue", pull: "pull" };

export function parseTaskReference(text) {
  const urls = findGithubUrls(text);
  const item = urls.find((url) => url.reference.number !== null);
  if (item) return withRest(item.reference, text, item.matched);
  const line = findRepositoryLine(text);
  if (line) return withRest(line.reference, text, line.matched);
  if (urls.length > 0) return withRest(urls[0].reference, text, urls[0].matched);
  return null;
}

function withRest(reference, text, matched) {
  const rest = text.replace(matched, "").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { ...reference, rest };
}

function findGithubUrls(text) {
  const found = [];
  for (const match of text.matchAll(GITHUB_URL_PATTERN)) {
    const matched = match[0].replace(TRAILING_PUNCTUATION, "");
    const reference = parseGithubUrl(matched);
    if (reference) found.push({ reference, matched });
  }
  return found;
}

export function parseGithubUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const reference = buildReference(segments[0], segments[1].replace(/\.git$/, ""));
  if (!reference) return null;
  const kind = ITEM_KINDS[segments[2]];
  if (kind && /^\d+$/.test(segments[3] ?? "")) return { ...reference, kind, number: Number(segments[3]) };
  return reference;
}

function findRepositoryLine(text) {
  const match = text.match(REPOSITORY_LINE_PATTERN);
  if (!match) return null;
  const value = match[1].replace(TRAILING_PUNCTUATION, "");
  const short = value.match(SHORT_NAME_PATTERN);
  const reference = short ? buildReference(short[1], short[2].replace(/\.git$/, "")) : parseGithubUrl(value);
  if (!reference) return null;
  return { reference, matched: match[0] };
}

function buildReference(owner, repo) {
  if (!isValidName(owner) || !isValidName(repo)) return null;
  return { owner, repo, kind: null, number: null };
}

function isValidName(name) {
  return NAME_PATTERN.test(name) && name !== "." && name !== "..";
}
