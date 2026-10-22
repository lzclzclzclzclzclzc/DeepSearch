import { z } from "zod";
import { SearchError, type SearchInput } from "@/shared/search";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const domain = z.string().trim().max(253).transform(value => value.toLowerCase()).refine(value => {
  if (!value.includes(".") || /[\s/:@?#*]/u.test(value)) return false;
  try { return new URL("https://" + value).hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)); } catch { return false; }
}, "请输入有效域名，例如 wikipedia.org");
const filtersSchema = z.object({
  languages: z.array(z.enum(["zh", "en"])).max(2).default([]),
  includeDomains: z.array(domain).max(5).default([]),
  excludeDomains: z.array(domain).max(5).default([]),
  after: date.nullable().default(null),
  before: date.nullable().default(null),
}).strict();
const inputSchema = z.object({ query: z.string(), filters: filtersSchema.default({ languages: [], includeDomains: [], excludeDomains: [], after: null, before: null }) }).strict();

export function compileQuery(raw: unknown): SearchInput & { effectiveQuery: string; timely: boolean } {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new SearchError("INVALID_FILTER", "请检查搜索词、域名、语言和日期格式。");
  const query = parsed.data.query.trim();
  if (!query) throw new SearchError("INVALID_QUERY", "请输入想查找的内容。");
  if ([...query].length > 128) throw new SearchError("QUERY_TOO_LONG", "搜索词最多为 128 个字符，请缩短后重试。");
  const filters = parsed.data.filters;
  filters.languages = [...new Set(filters.languages)].sort();
  filters.includeDomains = [...new Set(filters.includeDomains)];
  filters.excludeDomains = [...new Set(filters.excludeDomains)];
  if (filters.after && filters.before && filters.after >= filters.before) throw new SearchError("INVALID_FILTER", "开始日期须早于结束日期。");
  if (filters.includeDomains.some(d => filters.excludeDomains.includes(d))) throw new SearchError("FILTER_CONFLICT", "同一域名不能同时包含和排除。");
  // Quoted phrases are data, not operators. Preserve the original query verbatim.
  const operators = query.replace(/"[^"\n]*"/gu, "");
  const conflicts = [
    [filters.languages.length > 0, /(?:^|\s)lang:/iu],
    [filters.includeDomains.length + filters.excludeDomains.length > 0, /(?:^|\s)-?site:/iu],
    [Boolean(filters.after), /(?:^|\s)after:/iu],
    [Boolean(filters.before), /(?:^|\s)before:/iu],
  ] as const;
  if (conflicts.some(([active, regex]) => active && regex.test(operators))) throw new SearchError("FILTER_CONFLICT", "搜索词中已有同类筛选语法，请移除该语法或清除对应筛选。");
  const parts = [query];
  if (filters.includeDomains.length) parts.push(filters.includeDomains.map(d => `site:${d}`).join(" OR "));
  parts.push(...filters.excludeDomains.map(d => `-site:${d}`));
  if (filters.languages.length) parts.push(`lang:${filters.languages.join(",")}`);
  if (filters.after) parts.push(`after:${filters.after}`);
  if (filters.before) parts.push(`before:${filters.before}`);
  const effectiveQuery = parts.join(" ");
  if ([...effectiveQuery].length > 128) throw new SearchError("QUERY_TOO_LONG", "加上筛选后超过 128 个字符，请缩短关键词或减少筛选。");
  return { query, filters, effectiveQuery, timely: /今天|今日|最新|实时|刚刚|新闻|today|latest|breaking|live\b/iu.test(query) || Boolean(filters.after) };
}
