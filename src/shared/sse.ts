/** Decode complete SSE frames, including split UTF-8, CRLF and multiline data. */
export async function* readSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const parse = (frame: string) => {
    const lines = frame.split("\n");
    return { event: lines.find(line => line.startsWith("event:"))?.slice(6).trim() || "message", data: lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n") };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 100_000) throw new Error("SSE frame exceeds limit");
      // A trailing CR may belong to a CRLF split across chunks.
      buffer = buffer.replace(/\r\n/g, "\n");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = parse(buffer.slice(0, index)); buffer = buffer.slice(index + 2);
        if (frame.data) yield frame;
      }
      if (done) { if (buffer.trim()) { const frame = parse(buffer); if (frame.data) yield frame; } break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const encodeSSE = (event: string, data: unknown) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
