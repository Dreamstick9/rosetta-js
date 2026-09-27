import { repairReply } from "../src/model/repair.js";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";

const NL = "\n";
const CASES = [
  ["native call, clean", native("read_file", '{"path": "a.js"}'), "read_file", { path: "a.js" }],
  ["native call, alias name Read", native("Read", '{"path": "a.js"}'), "read_file", { path: "a.js" }],
  ["native call, trailing comma", native("bash", '{"command": "npm test",}'), "bash", { command: "npm test" }],
  ["native call, missing closing brace", native("search", '{"pattern": "add\\\\(", "path": "src"'), "search", { pattern: "add\\(", path: "src" }],
  ["native call, single quotes", native("grep", "{'pattern': 'TODO'}"), "search", { pattern: "TODO" }],
  ["native call, raw newlines in string", native("write_file", `{"path": "m.js", "content": "a${NL}b"}`), "write_file", { path: "m.js", content: `a${NL}b` }],
  ["native call, file_path alias argument", native("read_file", '{"file_path": "a.js"}'), "read_file", { path: "a.js" }],
  ["xml tag in text", text('Reading it.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call>'), "read_file", { path: "a.js" }],
  ["xml tag, unclosed at end", text('<tool_call>{"name": "shell", "arguments": {"command": "ls"}}'), "bash", { command: "ls" }],
  ["json-block fence", text('```json\n{"tool": "run", "args": {"cmd": "npm test"}}\n```'), "bash", { command: "npm test" }],
  ["qwen <function=> format", text("<tool_call>\n<function=edit_file>\n<parameter=path>\nm.js\n</parameter>\n<parameter=old_text>\na - b\n</parameter>\n<parameter=new_text>\na + b\n</parameter>\n</function>\n</tool_call>"), "edit_file", { path: "m.js", old_text: "a - b", new_text: "a + b" }],
  ["bare JSON in prose", text('I will run the tests: {"name": "bash", "arguments": {"command": "npm test"}} now.'), "bash", { command: "npm test" }],
  ["call inside <think>", text('<think>I should look.\n<tool_call>{"name": "list_files", "arguments": {}}</tool_call></think>'), "list_files", {}],
  ["OpenAI-shaped object in text", text('{"type": "function", "function": {"name": "read_file", "arguments": "{\\"path\\": \\"a.js\\"}"}}'), "read_file", { path: "a.js" }],
  ["python literals and bare keys", text("<tool_call>{name: 'list_files', arguments: {depth: 1, path: None}}</tool_call>"), "list_files", { depth: 1 }],
  ["number coerced for string arg", native("bash", '{"command": 42}'), "bash", { command: "42" }],
  ["DeepSeek DSML invoke in content", text('\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="read_file">\n<｜DSML｜ parameter name="path" string="true">math.js</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'), "read_file", { path: "math.js" }],
  ["GLM arg_key/arg_value", text("<tool_call>read_file\n<arg_key>path</arg_key>\n<arg_value>a.js</arg_value>\n</tool_call>"), "read_file", { path: "a.js" }],
  ["camelCase name ReadFile", native("ReadFile", '{"path": "a.js"}'), "read_file", { path: "a.js" }],
];
const NON_CALLS = [
  ["package.json in a final answer", text('Done. The manifest is:\n```json\n{"name": "smoke", "version": "1.0.0"}\n```')],
  ["plain answer", text("I fixed the bug in math.js.")],
];

function native(name, argumentsText) {
  return { content: "", toolCalls: [{ id: "call_x", name, arguments: argumentsText }] };
}

function text(content) {
  return { content, toolCalls: [] };
}

function runCase([label, reply, expectedName, expectedArgs]) {
  const { calls, repairs } = repairReply(reply, TOOL_DEFINITIONS);
  const call = calls[0];
  const passed = calls.length === 1 && !call.argumentsError && call.name === expectedName && sameJson(call.args, expectedArgs);
  const detail = passed ? repairs.join("; ") || "no repair needed" : JSON.stringify(calls);
  console.log(`${passed ? "PASS" : "FAIL"}  ${label.padEnd(38)} ${detail}`);
  return passed;
}

function runNonCall([label, reply]) {
  const { calls } = repairReply(reply, TOOL_DEFINITIONS);
  const passed = calls.length === 0;
  console.log(`${passed ? "PASS" : "FAIL"}  ${label.padEnd(38)} ${passed ? "no call found" : JSON.stringify(calls)}`);
  return passed;
}

function sameJson(first, second) {
  return JSON.stringify(sortKeys(first)) === JSON.stringify(sortKeys(second));
}

function sortKeys(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

const results = [...CASES.map(runCase), ...NON_CALLS.map(runNonCall)];
const failed = results.filter((passed) => !passed).length;
console.log(`${results.length - failed}/${results.length} repair cases passed`);
if (failed > 0) process.exit(1);
