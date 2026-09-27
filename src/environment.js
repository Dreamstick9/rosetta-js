const REMOVED_VARIABLES = new Set(["AI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"]);
const SECRET_NAME_PATTERN = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|_)/i;
const NO_PROMPT_VARIABLES = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  GIT_EDITOR: "true",
  EDITOR: "true",
  VISUAL: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  DEBIAN_FRONTEND: "noninteractive",
  PIP_NO_INPUT: "1",
  npm_config_yes: "true",
  CI: "true",
};

export function buildChildEnvironment() {
  const environment = { ...process.env, ...NO_PROMPT_VARIABLES };
  for (const name of Object.keys(environment)) {
    if (REMOVED_VARIABLES.has(name) || isSecretVariableName(name)) delete environment[name];
  }
  return environment;
}

export function isSecretVariableName(name) {
  return SECRET_NAME_PATTERN.test(name);
}

export function describeSecretPrint(args) {
  if (args.length === 0) return null;
  const secret = args.find(isSecretVariableName);
  return secret ? `it prints the secret variable ${secret}` : null;
}
