export function splitParts(text, maxBytes) {
  const parts = [];
  let current = [];
  let size = 0;
  for (const line of splitLongLines(text.split("\n"), maxBytes)) {
    const lineBytes = Buffer.byteLength(line) + 1;
    if (size + lineBytes > maxBytes && current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += lineBytes;
  }
  parts.push(current.join("\n"));
  return parts;
}

function* splitLongLines(lines, maxBytes) {
  const maxChars = Math.floor(maxBytes / 4);
  for (const line of lines) {
    if (Buffer.byteLength(line) <= maxBytes) {
      yield line;
      continue;
    }
    for (let start = 0; start < line.length; start += maxChars) yield line.slice(start, start + maxChars);
  }
}
