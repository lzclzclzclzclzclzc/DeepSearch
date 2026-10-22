import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SearchError } from "@/shared/search";
import type { Answer, AnswerBlock, ModelUsage } from "@/shared/answer";
import { encodeSSE } from "@/shared/sse";
import { digest, getConfig } from "@/server/infra/config";
import { resolveCredential, rejectCredential, type Credential } from "@/server/infra/credentials";
import { RedisCostControl } from "@/server/infra/control";
import { readyRedis } from "@/server/infra/redis";
import { recordRequest } from "@/server/infra/metrics";
import { RedisContentStore } from "@/server/search/storage";
import { compileQuery } from "@/server/search/query";
import { UpstreamFailure } from "@/server/deepseek/search";
import { fetchEvidence, streamSummary } from "@/server/deepseek/answer";
import { AnswerStore, acquireSummarySlot } from "./storage";
import { buildEvidence, modelCost, promptVersion, selectSources, validateParagraph, type SummaryEvidence } from "./evidence";
import { registerAnswer } from "./tasks";

const inputSchema = z.object({ requestId: z.uuid() }).strict();
const content = new RedisContentStore(); const costs = new RedisCostControl();
async function context(session: string, searchId: string) {
  if (!z.uuid().safeParse(searchId).success) throw new SearchError("SNAPSHOT_EXPIRED", "搜索结果不存在或已过期。", 410);
  const version = await content.version(session); const snapshot = await content.snapshot(session, searchId);
  if (!snapshot || Date.parse(snapshot.expiresAt) <= Date.now()) throw new SearchError("SNAPSHOT_EXPIRED", "搜索结果已过期，请重新搜索。", 410);
  const credential = await resolveCredential(session);
  const store = new AnswerStore(session, version, searchId, snapshot.expiresAt);
  const key = `answer:${searchId}:${digest(`${credential.scope}:${getConfig().SUMMARY_MODEL}:${promptVersion}`)}`;
  return { snapshot, credential, store, key };
}
export async function readAnswer(session: string, searchId: string) {
  const { store, key } = await context(session, searchId); return { answer: await store.read<Answer>(key) };
}
async function providerError(failure: unknown, credential: Credential, session: string) {
  if (failure instanceof SearchError) return failure;
  if (failure instanceof UpstreamFailure && [401, 402].includes(failure.status)) {
    if (credential.source === "personal") await rejectCredential(session, credential.scope, failure.status);
    else await costs.trip(failure.status, credential.scope);
    return new SearchError(failure.status === 401 ? "API_KEY_INVALID" : "API_BALANCE_INSUFFICIENT", failure.status === 401 ? "API key 无效，请在设置中更新。" : "API key 的账户余额不足，请充值后重试。", failure.status);
  }
  return new SearchError("UPSTREAM_UNAVAILABLE", "总结暂时无法完成，请稍后重试。", 502, true);
}
async function supplement(rows: SummaryEvidence[], credential: Credential, store: AnswerStore, signal: AbortSignal, timely: boolean) {
  const candidates = rows.filter(row => row.summary.trim().length < 60).slice(0, 3); let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
    while (next < candidates.length) {
      const row = candidates[next++]; signal.throwIfAborted(); await store.valid();
      const key = `fetch-v1:${digest(`${credential.scope}:${row.url}`)}`;
      const cached = await store.read<{ content: string; fetchedAt: string }>(key); if (cached !== null) { row.summary = cached.content; row.evidenceFetchedAt = cached.fetchedAt; continue; }
      const { control } = await readyRedis(); const domainKey = `ds:fetch:domain:${digest(row.domain)}`; const token = randomUUID();
      if (await control.set(domainKey, token, "PX", 9000, "NX") !== "OK") continue;
      let reservation: string | undefined;
      try {
        reservation = await costs.reserve(credential.scope, "fetch");
        const text = await fetchEvidence(row.url, credential.key, signal);
        await costs.settle(reservation, text.trim() ? "billed" : "free"); reservation = undefined;
        row.summary = text.slice(0, 10000); row.evidenceFetchedAt = new Date().toISOString(); await store.write(key, { content: row.summary, fetchedAt: row.evidenceFetchedAt }, timely ? 30000 : 300000);
      } catch (failure) {
        if (reservation) await costs.settle(reservation, failure instanceof UpstreamFailure && !failure.uncertain ? "free" : "uncertain");
        if (failure instanceof UpstreamFailure && [401, 402].includes(failure.status)) throw await providerError(failure, credential, store.session);
        if (signal.aborted) throw signal.reason;
        if (failure instanceof SearchError && failure.code === "SESSION_CLEARED") throw failure;
        // Missing or blocked pages leave the existing search snippet available.
      } finally { await control.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, domainKey, token).catch(() => {}); }
    }
  }));
}
function replay(answer: Answer) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encodeSSE("status", { phase: "cached", sources: answer.sources }));
    for (const block of answer.blocks) controller.enqueue(encodeSSE("answer.block", block));
    controller.enqueue(encodeSSE("done", answer)); controller.close();
  } }), { headers: streamHeaders });
}
const streamHeaders = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" };
export async function generateAnswer(session: string, ip: string, searchId: string, raw: unknown, requestSignal: AbortSignal) {
  const input = inputSchema.safeParse(raw);
  if (!input.success) throw new SearchError("INVALID_QUERY", "总结请求无效，请重新点击生成。", 400);
  const { store, key, snapshot, credential } = await context(session, searchId);
  const cached = await store.read<Answer>(key); if (cached) return replay(cached);
  const timely = compileQuery({ query: snapshot.query, filters: snapshot.filters }).timely;
  if (Date.now() - Date.parse(snapshot.fetchedAt) > (timely ? 30000 : 300000)) throw new SearchError("SNAPSHOT_EXPIRED", "搜索证据已不够新，请重新搜索后生成总结。", 410);
  if (!credential.key || credential.state !== "saved") throw new SearchError("API_KEY_INVALID", "请先在设置中配置可用的 API key。", 400);
  await costs.rate(`summary:${session}`, ip);
  const token = randomUUID(); if (!await store.claim(key, input.data.requestId, token)) {
    const answer = await store.read<Answer>(key); if (answer) return replay(answer);
    throw new SearchError("RATE_LIMITED", "总结状态正在更新，请稍后重试。", 409, true);
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, requestSignal, AbortSignal.timeout(getConfig().SUMMARY_TIMEOUT_MS)]);
  const unregister = registerAnswer(session, controller);
  let releaseSlot: (() => Promise<void>);
  try { releaseSlot = await acquireSummarySlot(signal); }
  catch (failure) { unregister(); await store.release(key, token); throw failure; }
  const started = Date.now();
  return new Response(new ReadableStream<Uint8Array>({
    async start(output) {
      let connected = true; const send = (event: string, value: unknown) => { if (connected) { try { output.enqueue(encodeSSE(event, value)); } catch { connected = false; controller.abort(); } } };
      const check = setInterval(() => { void store.valid().catch(() => controller.abort()); }, 500);
      let reservation: string | undefined; let usage: ModelUsage | undefined; let failed: unknown;
      try {
        send("status", { phase: "preparing" });
        const rows = selectSources(snapshot.results); await supplement(rows, credential, store, signal, timely); signal.throwIfAborted(); await store.valid();
        const { messages, sources } = buildEvidence(snapshot, rows);
        const blocks: AnswerBlock[] = []; const allowed = new Set(sources.map(source => source.sourceId));
        send("status", { phase: "generating", sources });
        const accept = (paragraph: string) => {
          const block = validateParagraph(paragraph, allowed);
          if (block && (!block.notice || !blocks.some(item => item.notice))) { blocks.push(block); send("answer.block", block); }
        };
        if (sources.length) {
          reservation = await costs.reserve(credential.scope, "model", Math.max(1, modelCost()));
          let buffer = "";
          for await (const text of streamSummary(messages, credential.key, signal, value => { usage = value; })) {
            signal.throwIfAborted(); await store.valid(); buffer = (buffer + text).replace(/\r\n/g, "\n");
            let boundary: number; while ((boundary = buffer.indexOf("\n\n")) >= 0) { accept(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
          }
          accept(buffer);
        }
        if (!blocks.some(block => !block.notice)) {
          const block: AnswerBlock = { text: "当前来源证据不足，无法生成可靠总结。请打开原网页，或调整关键词后重新搜索。", citations: [], notice: true };
          if (!blocks.length) { blocks.push(block); send("answer.block", block); }
        }
        signal.throwIfAborted(); await store.valid();
        const answer: Answer = { searchId, model: getConfig().SUMMARY_MODEL, generatedAt: new Date().toISOString(), blocks, sources };
        if (reservation) { await costs.settle(reservation, usage ? "billed" : "uncertain", usage ? modelCost(usage) : undefined); reservation = undefined; }
        await store.write(key, answer); send("done", answer);
        await recordRequest("summary", "success", Date.now() - started).catch(() => {});
      } catch (failure) {
        failed = failure;
        const error = signal.aborted ? new SearchError("UPSTREAM_UNAVAILABLE", controller.signal.aborted || requestSignal.aborted ? "总结已停止。" : "总结超时，请稍后重试。", 408, true) : await providerError(failure, credential, session);
        send("error", { code: error.code, message: error.message, retryable: error.retryable });
        await recordRequest("summary", signal.aborted ? "cancelled" : error.code, Date.now() - started).catch(() => {});
      } finally {
        controller.abort(); clearInterval(check); unregister();
        if (reservation) await costs.settle(reservation, usage ? "billed" : failed instanceof UpstreamFailure && !failed.uncertain ? "free" : "uncertain", usage ? modelCost(usage) : undefined).catch(() => {});
        await Promise.allSettled([store.release(key, token), releaseSlot()]);
        if (connected) { try { output.close(); } catch { /* Client disconnected. */ } }
      }
    },
    cancel() { controller.abort(); },
  }), { headers: streamHeaders });
}
