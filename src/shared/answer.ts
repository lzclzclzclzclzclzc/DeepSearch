export type Citation = { sourceId: string; title: string; url: string; publishedAt: string | null; fetchedAt: string };
export type AnswerBlock = { text: string; citations: string[]; notice?: boolean };
export type Answer = { searchId: string; model: string; generatedAt: string; blocks: AnswerBlock[]; sources: Citation[] };
export type ModelUsage = { promptTokens: number; cachedTokens: number; completionTokens: number };
