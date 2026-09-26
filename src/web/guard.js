import { execFileSync } from "node:child_process";
import { PROJECT_ROOT } from "../config.js";
import { WEB } from "./settings.js";

const GITHUB_REPO_PATTERN = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/\s"'<>)#?]|$)/gi;
const TASK_ITEM_PATTERN = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/\d+/gi;
const REPOSITORY_LINE_PATTERN = /^[ \t]*Repository:[ \t]*([\w.-]+)\/([\w.-]+)/gim;
const BLOCKED_WEB_VIEWS = new Set(["pull", "pulls", "commit", "commits", "compare", "blob", "tree", "raw", "blame", "archive", "branches", "tags"]);
const BLOCKED_API_VIEWS = new Set(["pulls", "commits", "compare", "git", "contents", "tarball", "zipball", "branches"]);
const CODE_HOSTS = new Set(["raw.githubusercontent.com", "codeload.github.com", "patch-diff.githubusercontent.com"]);

const targetNameCache = new Map();

export function findBlockReason(url, taskText) {
  const host = url.hostname.toLowerCase();
  if (isExcludedHost(host)) return `blocked: ${host} is in web.excludedDomains`;
  const view = readRepoView(host, url.pathname);
  if (!view?.blocked || !findTargetNames(taskText).some((name) => view.name.endsWith(name))) return null;
  return `blocked: ${view.owner}/${view.repo} is the project you are working on (or a copy of it); its pull requests, commits and source views are off limits. Its issues, releases and docs are allowed.`;
}

function isExcludedHost(host) {
  return WEB.excludedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function readRepoView(host, pathname) {
  const parts = pathname.split("/").filter(Boolean).map((part) => part.toLowerCase());
  if (host === "patch-diff.githubusercontent.com" && parts[0] === "raw") parts.shift();
  if (host === "github.com" || host === "www.github.com") return makeView(parts[0], parts[1], BLOCKED_WEB_VIEWS.has(parts[2]));
  if (host === "api.github.com" && parts[0] === "repos") return makeView(parts[1], parts[2], BLOCKED_API_VIEWS.has(parts[3]));
  if (CODE_HOSTS.has(host)) return makeView(parts[0], parts[1], true);
  return null;
}

function makeView(owner, repo, blocked) {
  if (!owner || !repo) return null;
  return { owner, repo, name: normalizeName(repo), blocked };
}

function normalizeName(name) {
  return name.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9]/g, "");
}

export function findTargetNames(taskText = "") {
  const key = `${PROJECT_ROOT}\n${taskText}`;
  if (!targetNameCache.has(key)) targetNameCache.set(key, collectTargetNames(taskText));
  return targetNameCache.get(key);
}

function collectTargetNames(taskText) {
  const matches = [
    ...readGitRemotes().matchAll(GITHUB_REPO_PATTERN),
    ...taskText.matchAll(TASK_ITEM_PATTERN),
    ...taskText.matchAll(REPOSITORY_LINE_PATTERN),
  ];
  const names = matches.map((match) => normalizeName(match[2])).filter(Boolean);
  return [...new Set(names)];
}

function readGitRemotes() {
  try {
    return execFileSync("git", ["remote", "-v"], { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}
