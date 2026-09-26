import { readFileSync } from "node:fs";

const CONFIG_URL = new URL("../config.json", import.meta.url);

export function loadConfig() {
  const fileConfig = JSON.parse(readFileSync(CONFIG_URL, "utf8"));
  return {
    ...fileConfig,
    baseUrl: process.env.AI_BASE_URL || fileConfig.baseUrl,
    model: process.env.AI_MODEL || fileConfig.model,
    apiKey: process.env.AI_API_KEY || "",
  };
}
