import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const HELPERS = ["camelcase", "splitOptionFlags", "humanReadableArgName", "editDistance", "suggestSimilar"];
const OLD_HOMES = ["lib/option.js", "lib/argument.js", "lib/command.js", "lib/help.js"];
const PUBLIC_EXPORTS = ["Argument", "Command", "CommanderError", "Help", "InvalidArgumentError", "InvalidOptionArgumentError", "Option", "createArgument", "createCommand", "createOption", "program"];
const problems = [];

const load = (file) => import(pathToFileURL(path.join(repo, file)).href);
const read = (file) => fs.readFileSync(path.join(repo, file), "utf8");

if (fs.existsSync(path.join(repo, "lib/suggestSimilar.js"))) problems.push("lib/suggestSimilar.js still exists");
if (!fs.existsSync(path.join(repo, "lib/utils.js"))) problems.push("lib/utils.js does not exist");
else {
  const utils = await load("lib/utils.js");
  for (const name of HELPERS) if (typeof utils[name] !== "function") problems.push(`lib/utils.js does not export ${name}`);
  if (typeof utils.camelcase === "function" && utils.camelcase("foo-bar-baz") !== "fooBarBaz") problems.push("camelcase changed behavior");
  if (typeof utils.splitOptionFlags === "function") {
    const flags = utils.splitOptionFlags("-m, --mixed <value>");
    if (flags.shortFlag !== "-m" || flags.longFlag !== "--mixed") problems.push("splitOptionFlags changed behavior");
  }
  if (typeof utils.suggestSimilar === "function" && !utils.suggestSimilar("hepl", ["help", "list"]).includes("help")) problems.push("suggestSimilar changed behavior");
  if (typeof utils.humanReadableArgName === "function" && utils.humanReadableArgName({ name: () => "file", variadic: true, required: true }) !== "<file...>") problems.push("humanReadableArgName changed behavior");
}

for (const file of OLD_HOMES) {
  const source = read(file);
  for (const name of HELPERS) {
    if (new RegExp(`function\\s+${name}\\b`).test(source)) problems.push(`${file} still defines ${name}`);
    if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source)) problems.push(`${file} re-exports ${name}`);
  }
  if (source.includes("suggestSimilar.js")) problems.push(`${file} imports suggestSimilar.js`);
}

const argument = await load("lib/argument.js");
if ("humanReadableArgName" in argument) problems.push("lib/argument.js still exports humanReadableArgName");

const index = await load("index.js");
const exported = Object.keys(index).sort();
if (JSON.stringify(exported) !== JSON.stringify(PUBLIC_EXPORTS)) problems.push(`index.js exports changed: ${exported.join(", ")}`);

if (problems.length > 0) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log("structure OK");
