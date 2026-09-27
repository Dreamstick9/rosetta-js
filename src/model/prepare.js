import { detectFamily, probeModel } from "./probe.js";
import { preferReasoningField } from "./reasoning.js";
import { readModelSettings } from "./settings.js";
import { writeDimLine } from "../ui.js";

const TOOL_CALL_TAG_FAMILIES = new Set(["qwen", "glm"]);

let activeProfile = null;

export async function prepareModel(config) {
  const settings = readModelSettings(config);
  const probed = settings.probe ? await probeModel(config) : unprobedProfile(config);
  activeProfile = { ...probed, dialect: chooseDialect(settings.dialect, probed), settings };
  preferReasoningField(activeProfile.reasoningField);
  const capped = capContext(config, activeProfile.contextWindow);
  writeDimLine(describeProfile(activeProfile, capped ? config.maxContextTokens : null));
}

export function getModelProfile(config) {
  activeProfile ??= { ...unprobedProfile(config), dialect: "native", settings: readModelSettings(config) };
  return activeProfile;
}

function unprobedProfile(config) {
  return { family: detectFamily(config.model), nativeTools: true, reasoningField: null, cacheField: null, effortAccepted: true, contextWindow: null, cached: false, problem: "probe off" };
}

function chooseDialect(setting, profile) {
  if (setting !== "auto") return setting;
  if (profile.nativeTools) return "native";
  return TOOL_CALL_TAG_FAMILIES.has(profile.family) ? "xml" : "json-block";
}

function capContext(config, contextWindow) {
  if (!contextWindow) return false;
  const limit = contextWindow - config.maxOutputTokens;
  if (limit >= config.maxContextTokens) return false;
  config.maxContextTokens = limit;
  return true;
}

function describeProfile(profile, cappedContext) {
  const { settings } = profile;
  const effort = profile.effortAccepted && settings.reasoningEffort ? `${settings.reasoningEffort}→${settings.escalatedReasoningEffort}` : "not sent";
  const parts = [
    `probe: ${profile.family}`,
    `tools ${profile.dialect}${profile.nativeTools ? "" : " (no native tools)"}`,
    `reasoning ${profile.reasoningField ?? "none seen"}`,
    `cached tokens ${profile.cacheField ?? "not reported"}`,
    `effort ${effort}`,
    `context ${profile.contextWindow ?? "unknown"}`,
  ];
  if (cappedContext) parts.push(`budget capped to ${cappedContext}`);
  parts.push(profile.cached ? "cached" : profile.problem ?? "fresh");
  return parts.join(" · ");
}
