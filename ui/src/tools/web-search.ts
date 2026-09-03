import { BaseTool, ToolKind } from "./base-tool.js";
import type { ToolExecutionContext, ToolResult } from "../core/types.js";

export class WebSearchTool extends BaseTool {
  name = "web_search";
  description =
    "Search the web for information. Uses Brave Search API if BRAVE_API_KEY is set, otherwise falls back to free DuckDuckGo API.";
  isDestructive = false;
  readOnly = true;
  canRunInParallel = false;
  searchHint = "search query web lookup find information";
  kind = ToolKind.Search;

  inputSchema = {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query to find information",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default: 5)",
      },
    },
    required: ["query"],
  };

  private getApiKey(): string | undefined {
    return process.env.BRAVE_API_KEY;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = input.query as string;
    const limit = (input.limit as number) || 5;

    if (!query || query.trim().length === 0) {
      return this.error("Search query is required");
    }

    const braveKey = this.getApiKey();

    if (braveKey) {
      return this.searchBrave(query, limit, braveKey);
    } else {
      return this.searchDuckDuckGo(query, limit);
    }
  }

  private async searchBrave(
    query: string,
    limit: number,
    apiKey: string,
  ): Promise<ToolResult> {
    try {
      const response = await fetch("https://api.brave.com/res/v1/web/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        body: JSON.stringify({
          q: query,
          count: Math.min(limit, 20),
          extra_snippet: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return this.error(
          `Brave Search failed: ${response.status} - ${errorText}`,
        );
      }

      const data = (await response.json()) as {
        web?: {
          results?: Array<{
            title: string;
            url: string;
            description: string;
          }>;
        };
      };

      const results = data.web?.results || [];

      if (results.length === 0) {
        return this.success(`No results found for: ${query}`);
      }

      const formattedResults = results
        .slice(0, limit)
        .map((r, i) => {
          return `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || ""}`;
        })
        .join("\n\n");

      return this.success(
        `<query>${query}</query>\n<provider>Brave Search</provider>\n<count>${results.length}</count>\n\n<results>\n${formattedResults}\n</results>`,
      );
    } catch (err) {
      return this.handleError(err, "Brave search failed");
    }
  }

  private async searchDuckDuckGo(
    query: string,
    limit: number,
  ): Promise<ToolResult> {
    try {
      const encodedQuery = encodeURIComponent(query);
      const response = await fetch(
        `https://ddg-api.vercel.app/search?q=${encodedQuery}&limit=${limit}`,
      );

      if (!response.ok) {
        return this.error(`Search failed: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        results?: Array<{ title: string; url: string; snippet: string }>;
      };

      const results = data.results || [];

      if (results.length === 0) {
        return this.success(`No results found for: ${query}`);
      }

      const formattedResults = results
        .map((r, i) => {
          return `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`;
        })
        .join("\n\n");

      return this.success(
        `<query>${query}</query>\n<provider>DuckDuckGo (free)</provider>\n<count>${results.length}</count>\n\n<results>\n${formattedResults}\n</results>`,
      );
    } catch (err) {
      return this.handleError(err, "Web search failed");
    }
  }
}
