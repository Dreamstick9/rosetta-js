export async function streamChat(config, messages, tools, onText) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return readStream(response.body, onText);
}

async function readStream(body, onText) {
  const reply = { content: "", toolCalls: [], usage: null };
  for await (const data of sseEvents(body)) {
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(`API error: ${JSON.stringify(chunk.error).slice(0, 500)}`);
    if (chunk.usage) reply.usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (delta) applyDelta(reply, delta, onText);
  }
  return reply;
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (data === "[DONE]") return;
      if (data) yield data;
    }
  }
}

function applyDelta(reply, delta, onText) {
  if (delta.content) {
    reply.content += delta.content;
    onText(delta.content);
  }
  for (const part of delta.tool_calls ?? []) {
    const call = (reply.toolCalls[part.index ?? 0] ??= { id: "", name: "", arguments: "" });
    call.id ||= part.id ?? "";
    call.name += part.function?.name ?? "";
    call.arguments += part.function?.arguments ?? "";
  }
}
