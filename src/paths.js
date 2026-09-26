import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const HOME = canonicalPath(os.homedir());
const TMP_ROOT = canonicalPath("/tmp");
const DEVICE_FILES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero", "/dev/random", "/dev/urandom"]);
const CREDENTIAL_PATHS = [".ssh", ".aws", ".config/gh", ".gnupg", ".netrc", ".git-credentials", ".docker/config.json"].map((name) => path.join(HOME, name));
const SECRET_FILE_PATTERN = /(\.pem|\.key)$|^\.env(\..*)?$/;

export function canonicalPath(target) {
  const absolute = path.resolve(target);
  let existing = absolute;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  return path.join(realPath(existing), path.relative(existing, absolute));
}

function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function repoRoot() {
  return canonicalPath(PROJECT_ROOT);
}

function isInside(target, folder) {
  return target === folder || target.startsWith(`${folder}${path.sep}`);
}

function isStrictlyInside(target, folder) {
  return target !== folder && isInside(target, folder);
}

function isInWritableArea(target) {
  return isInside(target, repoRoot()) || isStrictlyInside(target, TMP_ROOT);
}

export function describeWriteProblem(target) {
  if (DEVICE_FILES.has(target) || target.startsWith("/dev/fd/")) return null;
  if (isInWritableArea(canonicalPath(target))) return null;
  return `${target} is outside the working folder and /tmp`;
}

export function describeDeleteProblem(target, recursive) {
  const real = canonicalPath(target);
  if (recursive && real === repoRoot()) return `it would delete the whole working folder ${real}`;
  if (recursive && real === HOME) return "it would delete your home folder";
  if (isInWritableArea(real)) return null;
  return `${target} is outside the working folder and /tmp`;
}

export function describeReadProblem(target) {
  const real = canonicalPath(target);
  if (CREDENTIAL_PATHS.some((credentialPath) => isInside(real, credentialPath))) return `${target} holds credentials`;
  const outsideRepo = !isInside(real, repoRoot());
  if (outsideRepo && SECRET_FILE_PATTERN.test(path.basename(real))) return `${target} is a secret file outside the working folder`;
  return null;
}
