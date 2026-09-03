/**
 * DynaMind API — News Provider
 *
 * Wraps the DynaMind Data API's news endpoints as a NewsProvider.
 * Provides: news articles, market sentiment.
 */

import type { NewsProvider, NewsArticle, SentimentData, NewsOptions } from "dynatrader";

export interface DynaMindNewsConfig {
  baseUrl: string;
  apiKey?: string;
}

export function createNewsProvider(config: DynaMindNewsConfig): NewsProvider {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  async function request<T>(path: string): Promise<T> {
    const resp = await fetch(`${config.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`DynaMind API ${resp.status}: ${resp.statusText}`);
    }
    return resp.json() as Promise<T>;
  }

  return {
    async getNews(options?: NewsOptions): Promise<NewsArticle[]> {
      const params = new URLSearchParams();
      if (options?.symbol) params.set("coin", options.symbol);
      if (options?.category) params.set("type", options.category);
      if (options?.limit) params.set("limit", String(options.limit));
      if (options?.minScore) params.set("minScore", String(options.minScore));

      const data = await request<{
        news: Array<{
          title: string;
          url: string;
          source: string;
          published_at: string;
          sentiment?: string;
          score?: number;
          categories?: string[];
        }>;
      }>(`/api/v1/news?${params}`);

      return data.news.map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source,
        publishedAt: n.published_at,
        sentiment: n.sentiment as NewsArticle["sentiment"],
        score: n.score,
        categories: n.categories,
      }));
    },

    async getSentiment(symbol?: string): Promise<SentimentData> {
      const params = symbol ? `?coin=${encodeURIComponent(symbol)}` : "";
      const data = await request<{
        sentiment: {
          overall: string;
          score: number;
          sources: number;
        };
      }>(`/api/v1/sentiment${params}`);

      return {
        overall: data.sentiment.overall as SentimentData["overall"],
        score: data.sentiment.score,
        sources: data.sentiment.sources,
      };
    },
  };
}
