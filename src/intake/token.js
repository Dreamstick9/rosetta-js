import { spawnSync } from "node:child_process";
import { buildChildEnvironment } from "../environment.js";

const GH_TIMEOUT_MS = 5000;
const HIDDEN = "[hidden]";
const GIT_AUTH_KEY = "http.https://github.com/.extraheader";

export function findGithubToken() {
  const fromEnvironment = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnvironment) return fromEnvironment.trim();
  return readGhToken();
}

function readGhToken() {
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
    env: { ...buildChildEnvironment(), GH_PROMPT_DISABLED: "1" },
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function buildGitEnvironment(token) {
  const settings = [["credential.helper", ""]];
  if (token) settings.push([GIT_AUTH_KEY, `AUTHORIZATION: basic ${encodeBasicAuth(token)}`]);
  const environment = { ...buildChildEnvironment(), GIT_CONFIG_COUNT: String(settings.length) };
  for (const [index, [key, value]] of settings.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return environment;
}

function encodeBasicAuth(token) {
  return Buffer.from(`x-access-token:${token}`).toString("base64");
}

export function hideToken(text, token) {
  if (!token) return text;
  return text.replaceAll(token, HIDDEN).replaceAll(encodeBasicAuth(token), HIDDEN);
}
