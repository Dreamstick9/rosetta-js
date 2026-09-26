import { readFileSync } from "node:fs";

const CONFIG_URL = new URL("../config.json", import.meta.url);
const DEFAULT_MAX_TURNS = 60;
const FREE_PRICING = { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 };

export const PROJECT_ROOT = process.cwd();

export function loadConfig() {
  const fileConfig = JSON.parse(readFileSync(CONFIG_URL, "utf8"));
  return {
    ...fileConfig,
    maxTurns: fileConfig.maxTurns ?? DEFAULT_MAX_TURNS,
    pricing: fileConfig.pricing ?? FREE_PRICING,
    baseUrl: process.env.AI_BASE_URL || fileConfig.baseUrl,
    model: process.env.AI_MODEL || fileConfig.model,
    apiKey: process.env.AI_API_KEY || "",
  };
}
