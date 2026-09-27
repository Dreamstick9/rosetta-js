const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function parseSettings(texts) {
  const settings = { env: {}, config: {} };
  for (const text of texts) {
    for (const item of text.split(/[\s,]+/).filter(Boolean)) addSetting(settings, item);
  }
  return settings;
}

function addSetting(settings, item) {
  const index = item.indexOf("=");
  if (index < 1) throw new Error(`Setting "${item}" must look like KEY=value or path.to.field=value`);
  const key = item.slice(0, index);
  const value = item.slice(index + 1);
  if (ENV_NAME.test(key)) settings.env[key] = value;
  else settings.config[key] = parseValue(value);
}

function parseValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function applyConfigSettings(config, overrides) {
  for (const [field, value] of Object.entries(overrides)) setField(config, field.split("."), value);
  return config;
}

function setField(target, keys, value) {
  const last = keys.at(-1);
  for (const key of keys.slice(0, -1)) {
    if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
    target = target[key];
  }
  target[last] = value;
}
