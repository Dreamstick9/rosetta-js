import { DIALECT_NAMES } from "./dialects.js";

const EFFORTS = ["", "minimal", "low", "medium", "high"];

export function readModelSettings(config) {
  const settings = { ...config.adapter };
  if (process.env.AI_DIALECT) settings.dialect = process.env.AI_DIALECT;
  if (![...DIALECT_NAMES, "auto"].includes(settings.dialect)) fail("adapter.dialect", `one of auto, ${DIALECT_NAMES.join(", ")}`);
  if (!EFFORTS.includes(settings.reasoningEffort)) fail("adapter.reasoningEffort", `one of ${EFFORTS.join(", ")} ("" sends none)`);
  if (!EFFORTS.includes(settings.escalatedReasoningEffort)) fail("adapter.escalatedReasoningEffort", `one of ${EFFORTS.join(", ")}`);
  if (typeof settings.probe !== "boolean") fail("adapter.probe", "true or false");
  return settings;
}

function fail(field, expected) {
  console.error(`config.json: "${field}" must be ${expected}.`);
  process.exit(1);
}
