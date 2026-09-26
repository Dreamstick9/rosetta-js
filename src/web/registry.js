const RECENT_VERSIONS = 15;
const RELEASES_SHOWN = 8;
const RELEASE_BODY_CHARS = 2500;
const DIST_TAGS_SHOWN = 10;

const FAST_PATHS = [
  { pattern: /^(?:www\.)?pypi\.org\/(?:project|pypi)\/([^/]+)/, requests: (name) => [`https://pypi.org/pypi/${name}/json`], render: renderPypi },
  { pattern: /^(?:www\.)?npmjs\.com\/package\/((?:@[^/]+\/)?[^/]+)/, requests: npmRequests, render: renderNpm },
  { pattern: /^registry\.npmjs\.org\/((?:@[^/]+\/)?[^/]+)\/?$/, requests: npmRequests, render: renderNpm },
  { pattern: /^crates\.io\/(?:api\/v1\/)?crates\/([^/]+)/, requests: (name) => [`https://crates.io/api/v1/crates/${name}`], render: renderCrate },
  { pattern: /^(?:github\.com|api\.github\.com\/repos)\/([^/]+\/[^/]+)\/releases/, requests: (repo) => [`https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_SHOWN}`], render: renderReleases },
];

export function findFastPath(url) {
  const key = `${url.hostname}${decodeURIComponent(url.pathname)}`;
  for (const fastPath of FAST_PATHS) {
    const match = fastPath.pattern.exec(key);
    if (match) return { requests: fastPath.requests(match[1]), render: (bodies) => fastPath.render(match[1], bodies) };
  }
  return null;
}

export function rewriteToRaw(url) {
  const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  if (url.hostname !== "github.com" || !match) return url;
  return new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`);
}

function npmRequests(name) {
  const encoded = name.replace("/", "%2F");
  return [`https://registry.npmjs.org/${encoded}/latest`, `https://registry.npmjs.org/-/package/${encoded}/dist-tags`];
}

function renderPypi(name, [data]) {
  const info = data.info ?? {};
  const releases = Object.entries(data.releases ?? {})
    .filter(([, files]) => files.length > 0)
    .map(([version, files]) => ({ version, date: files[0].upload_time?.slice(0, 10) ?? "", yanked: files.every((file) => file.yanked) }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_VERSIONS);
  return [
    `PyPI ${info.name ?? name}: latest ${info.version}`,
    `Summary: ${info.summary ?? ""}`,
    `Requires-Python: ${info.requires_python || "any"}`,
    "Project URLs:",
    ...Object.entries(info.project_urls ?? {}).map(([label, link]) => `  ${label}: ${link}`),
    "Requires:",
    ...(info.requires_dist ?? []).slice(0, RECENT_VERSIONS).map((line) => `  ${line}`),
    "Recent releases (newest first):",
    ...releases.map((release) => `  ${release.version}  ${release.date}${release.yanked ? "  (yanked)" : ""}`),
  ].join("\n");
}

function renderNpm(name, [latest, distTags]) {
  return [
    `npm ${latest.name ?? name}: latest ${latest.version}`,
    `Description: ${latest.description ?? ""}`,
    `Dist-tags: ${listDistTags(distTags ?? {})}`,
    `Homepage: ${latest.homepage ?? ""}`,
    `Repository: ${latest.repository?.url ?? latest.repository ?? ""}`,
    `Engines: ${JSON.stringify(latest.engines ?? {})}`,
    `Dependencies: ${JSON.stringify(latest.dependencies ?? {})}`,
    `Peer dependencies: ${JSON.stringify(latest.peerDependencies ?? {})}`,
    `One version: https://registry.npmjs.org/${name}/<version>`,
  ].join("\n");
}

function listDistTags(distTags) {
  const tags = Object.entries(distTags).sort(([a], [b]) => Number(b === "latest") - Number(a === "latest"));
  return tags.slice(0, DIST_TAGS_SHOWN).map(([tag, version]) => `${tag}=${version}`).join(", ");
}

function renderCrate(name, [data]) {
  const crate = data.crate ?? {};
  const versions = (data.versions ?? []).slice(0, RECENT_VERSIONS);
  return [
    `crates.io ${crate.name ?? name}: latest stable ${crate.max_stable_version ?? crate.newest_version}`,
    `Description: ${crate.description ?? ""}`,
    `Repository: ${crate.repository ?? ""}`,
    `Documentation: ${crate.documentation ?? `https://docs.rs/${name}`}`,
    "Recent versions (newest first):",
    ...versions.map((version) => `  ${version.num}  ${version.created_at?.slice(0, 10) ?? ""}${version.yanked ? "  (yanked)" : ""}  rust ${version.rust_version ?? "?"}`),
  ].join("\n");
}

function renderReleases(repo, [releases]) {
  if (!Array.isArray(releases) || releases.length === 0) return `No GitHub releases for ${repo}. Try its CHANGELOG file or tags.`;
  return releases.map((release) => [
    `## ${release.tag_name}${release.name && release.name !== release.tag_name ? ` — ${release.name}` : ""} (${release.published_at?.slice(0, 10) ?? "draft"})${release.prerelease ? " prerelease" : ""}`,
    trimBody(release.body ?? ""),
  ].join("\n")).join("\n\n");
}

function trimBody(body) {
  const text = body.replace(/\r/g, "").trim();
  return text.length <= RELEASE_BODY_CHARS ? text : `${text.slice(0, RELEASE_BODY_CHARS)}…`;
}
