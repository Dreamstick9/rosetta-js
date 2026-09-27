export const DIALECT_NAMES = ["native", "xml", "json-block"];

const TEXT_STOP = ["<tool_result"];
const EXAMPLES = {
  xml: '<tool_call>{"name": "read_file", "arguments": {"path": "src/app.js"}}</tool_call>',
  "json-block": '```json\n{"tool": "read_file", "args": {"path": "src/app.js"}}\n```',
};
const SHAPES = { xml: "<tool_call>…</tool_call> block", "json-block": "```json block" };

export function createDialect(name, toolDefinitions) {
  if (name === "native") return nativeDialect(toolDefinitions);
  return textDialect(name, toolDefinitions);
}

function nativeDialect(toolDefinitions) {
  return {
    name: "native",
    systemSuffix: "",
    requestTools: toolDefinitions,
    stop: undefined,
    assistantMessage(content, calls) {
      const message = { role: "assistant", content };
      if (calls.length > 0) message.tool_calls = calls.map(toApiToolCall);
      return message;
    },
    resultMessages(results) {
      return results.map(({ call, content }) => ({ role: "tool", tool_call_id: call.id, content }));
    },
  };
}

function toApiToolCall(call) {
  return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments ?? "{}" } };
}

function textDialect(name, toolDefinitions) {
  return {
    name,
    systemSuffix: renderToolPrompt(name, toolDefinitions),
    requestTools: undefined,
    stop: TEXT_STOP,
    assistantMessage(content) {
      return { role: "assistant", content };
    },
    resultMessages(results) {
      const blocks = results.map(({ call, content }) => `<tool_result name="${call.name}">\n${content}\n</tool_result>`);
      return [{ role: "user", content: blocks.join("\n") }];
    },
  };
}

function renderToolPrompt(name, toolDefinitions) {
  const tools = toolDefinitions.map(({ function: tool }) => `- ${tool.name}: ${tool.description}\n  arguments: ${JSON.stringify(tool.parameters)}`);
  return [
    "",
    "",
    "# Tool calls",
    `Call a tool by writing one ${SHAPES[name]} per call, exactly like this:`,
    EXAMPLES[name],
    "Arguments must be valid JSON (escape newlines in strings as \\n). You may write several calls in one reply, then stop.",
    "The results come back in the next message inside <tool_result> tags. A reply without a tool call ends your turn.",
    "",
    "Available tools:",
    ...tools,
  ].join("\n");
}
