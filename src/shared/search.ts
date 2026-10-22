export type SearchFilters = {
  languages: ("zh" | "en")[];
  includeDomains: string[];
  excludeDomains: string[];
  after: string | null;
  before: string | null;
};
export const emptyFilters = (): SearchFilters => ({ languages: [], includeDomains: [], excludeDomains: [], after: null, before: null });
export type SearchInput = { query: string; filters: SearchFilters };
export type SearchResult = {
  sourceId: string;
  title: string;
  url: string;
  domain: string;
  siteName: string;
  snippet: string;
  publishedAt: string | null;
};
export type SearchResponse = {
  requestId: string;
  searchId: string;
  query: string;
  effectiveQuery: string;
  fetchedAt: string;
  expiresAt: string;
  cache: "hit" | "miss" | "stale";
  results: SearchResult[];
  snapshotCount: number;
  page: number;
  pageSize: 10;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  warnings: string[];
};
export type ErrorCode = "REQUEST_CANCELLED" | "INVALID_QUERY" | "QUERY_TOO_LONG" | "FILTER_CONFLICT" | "INVALID_FILTER" | "INVALID_PAGE" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "SNAPSHOT_EXPIRED" | "SESSION_CLEARED" | "FORBIDDEN" | "SERVICE_UNAVAILABLE" | "API_KEY_INVALID" | "API_BALANCE_INSUFFICIENT";
export type DailyUsage = { day: string; timeZone: "Asia/Shanghai"; totalCny: number; confirmedCny: number; pendingCny: number; uncertainCny: number; attempts: number; paidSearches: number; summaries: number; fetches: number };
export type ApiError = { error: { code: ErrorCode; message: string; retryable: boolean }; requestId: string };
export class SearchError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400, public retryable = false, public retryAfter?: number) { super(message); }
}
