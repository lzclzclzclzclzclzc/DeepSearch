import { z } from "zod";
import { getConfig } from "@/server/infra/config";
import { readSSE } from "@/shared/sse";
import type { ModelUsage } from "@/shared/answer";
import { UpstreamFailure, canonicalUrl } from "./search";

export type Message = { role: "system" | "user"; content: string };
export async function* streamSummary(messages: Message[], key: string, signal: AbortSignal, onUsage: (usage: ModelUsage) => void) {
  let response: Response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: getConfig().SUMMARY_MODEL, messages, thinking: { type: "disabled" }, stream: true, stream_options: { include_usage: true }, max_tokens: 2000, temperature: 0.2 }),
      signal, redirect: "error", cache: "no-store" });
  } catch { throw new UpstreamFailure(0, 0, true); }
  if (!response.ok) { await response.body?.cancel(); throw new UpstreamFailure(response.status, 0, false); }
  if (!response.body) throw new UpstreamFailure(502, 0, true);
  let complete = false; let size = 0; let reason: string | null = null;
  try {
    for await (const frame of readSSE(response.body)) {
      if (frame.data === "[DONE]") { complete = true; break; }
      const chunk = JSON.parse(frame.data);
      if (chunk.error) throw new Error("Provider stream error");
      const usage = chunk.usage;
      if (usage) {
        const prompt = usage.prompt_tokens; const output = usage.completion_tokens;
        const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
        if (![prompt, output, cached].every(n => Number.isSafeInteger(n) && n >= 0) || cached > prompt) throw new Error("Invalid usage");
        onUsage({ promptTokens: prompt, completionTokens: output, cachedTokens: cached });
      }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) reason = choice.finish_reason;
      const text = choice?.delta?.content;
      if (typeof text === "string") { size += Buffer.byteLength(text); if (size > 32_000) throw new Error("Answer exceeds limit"); yield text; }
    }
    if (!complete || reason !== "stop") throw new Error("Incomplete model answer");
  } catch (failure) { if (signal.aborted) throw signal.reason; throw failure instanceof UpstreamFailure ? failure : new UpstreamFailure(502, 0, true); }
}

export async function fetchEvidence(url: string, key: string, signal: AbortSignal): Promise<string> {
  const canonical = canonicalUrl(url); const host = canonical ? new URL(canonical).hostname : "";
  if (!canonical || host.endsWith(".internal") || /^(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.|192\.88\.99\.|198\.(?:1[89]|51)\.|203\.0\.113\.|(?:22[4-9]|2[3-5]\d)\.)/.test(host)) throw new UpstreamFailure(400, 0, false);
  let response: Response;
  try { response = await fetch("https://api.deepseek.com/v1/tools/fetch", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), cache: "no-store", redirect: "error" }); }
  catch { throw new UpstreamFailure(0, 0, true); }
  if (!response.ok) { await response.body?.cancel(); throw new UpstreamFailure(response.status, 0, false); }
  const reader = response.body?.getReader(); if (!reader) throw new UpstreamFailure(502, 0, true);
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1_000_000) throw new Error("Fetch exceeds limit"); chunks.push(value); }
    return z.object({ content: z.string(), title: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).content;
  } catch { throw new UpstreamFailure(502, 0, true); }
  finally { await reader.cancel().catch(() => {}); }
}
