/**
 * Tool Result Compressor - Hybrid compression for tool results.
 *
 * Implements the compression step:
 *   Prompt → Decide → Run → Compress → (not done) → back to Prompt
 *
 * Uses a two-tier approach:
 *   Tier 1: SmartCrusher (deterministic, fast, no API calls)
 *   Tier 2: LLM summarization (better quality, uses tokens)
 *
 * The hybrid selects the best strategy based on:
 *   - Result size (small = skip, medium = SmartCrusher, large = LLM)
 *   - Model context window (small models get more aggressive compression)
 *   - Config settings (compressToolResults toggle, maxToolResultTokens)
 */

import type { ToolResult } from "@dyna/contracts";
import { SmartCrusher } from "./smart-crusher";
import { TokenCounter } from "./token-counter";
import { ContentRouter } from "./content-router";
import type { ContentType } from "@dyna/contracts";

export interface ToolResultCompressorConfig {
  /** Enable/disable tool result compression (default: true) */
  enabled: boolean;
  /** Maximum tokens per tool result after compression (default: 500) */
  maxToolResultTokens: number;
  /** Token threshold to trigger LLM summarization (default: 1000) */
  llmSummarizeThreshold: number;
  /** Model context window in tokens (used to scale compression aggressiveness) */
  contextWindow: number;
  /** Whether to use LLM summarization (default: true) */
  useLlmSummarization: boolean;
  /** Maximum number of tool results to keep in prompt (default: 20) */
  maxResultsInPrompt: number;
}

const DEFAULT_CONFIG: ToolResultCompressorConfig = {
  enabled: true,
  maxToolResultTokens: 500,
  llmSummarizeThreshold: 1000,
  contextWindow: 128000,
  useLlmSummarization: true,
  maxResultsInPrompt: 20,
};

export interface CompressedToolResult {
  /** Original tool call ID */
  toolCallId: string;
  /** Tool name */
  toolName: string;
  /** Compressed result content */
  compressedContent: string;
  /** Original token count */
  originalTokens: number;
  /** Compressed token count */
  compressedTokens: number;
  /** Compression ratio (compressed/original) */
  ratio: number;
  /** Whether LLM summarization was used */
  usedLlm: boolean;
  /** Whether this result was fully preserved (under threshold) */
  preserved: boolean;
  /** True when the full result can be retrieved with get_tool_result using toolCallId. */
  fullResultAvailable?: boolean;
}

export interface CompressionStats {
  totalResults: number;
  compressedResults: number;
  preservedResults: number;
  llmSummarizedResults: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  averageRatio: number;
}

/**
 * ToolResultCompressor - Hybrid compression for tool results.
 *
 * Implements the compression step with a two-tier approach:
 *   Tier 1: SmartCrusher (deterministic, fast)
 *   Tier 2: LLM summarization (better quality)
 *
 * Usage:
 *   const compressor = new ToolResultCompressor({ contextWindow: 128000 });
 *   const compressed = await compressor.compressResults(toolResults, llmCaller);
 *   // Use compressed results in prompt instead of raw results
 */
export class ToolResultCompressor {
  private config: Required<ToolResultCompressorConfig>;
  private smartCrusher: SmartCrusher;
  private tokenCounter: TokenCounter;
  private contentRouter: ContentRouter;
  private stats: CompressionStats;

  constructor(config?: Partial<ToolResultCompressorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = new TokenCounter();
    this.contentRouter = new ContentRouter();
    this.smartCrusher = new SmartCrusher(this.tokenCounter, this.contentRouter, {
      maxTokens: this.config.maxToolResultTokens,
    });
    this.stats = this.resetStats();
  }

  /**
   * Compress a batch of tool results.
   *
   * @param results - Tool results from batch execution
   * @param llmCaller - Optional LLM caller for Tier 2 summarization
   * @returns Compressed results ready for prompt injection
   */
  async compressResults(
    results: Array<{
      tool: string;
      args: Record<string, unknown>;
      result: ToolResult;
      durationMs?: number;
      id?: string;
    }>,
    llmCaller?: (prompt: string) => Promise<string>,
  ): Promise<CompressedToolResult[]> {
    if (!this.config.enabled) {
      return results.map(r => this.preserveAsIs(r));
    }

    const compressed: CompressedToolResult[] = [];
    let totalOriginal = 0;
    let totalCompressed = 0;
    let llmCount = 0;
    let preservedCount = 0;

    for (const r of results) {
      const content = this.extractContent(r.result);
      const originalTokens = this.tokenCounter.count(content);
      const compactableContent = this.collapseRepeatedLines(content);

      // Tier 0: Skip if already small enough
      if (originalTokens <= this.config.maxToolResultTokens) {
        compressed.push(this.preserveAsIs(r));
        totalOriginal += originalTokens;
        totalCompressed += originalTokens;
        preservedCount++;
        continue;
      }

      // Tier 1: SmartCrusher (deterministic compression)
      const contentRoute = this.contentRouter.classify(content);
      const crushResult = this.smartCrusher.compress(compactableContent, contentRoute.contentType);

      // Check if SmartCrusher reduced enough
      if (crushResult.compressedTokens <= this.config.maxToolResultTokens) {
        const output = this.withPreservedContext(r.result, crushResult.compressed, r.id);
        const outputTokens = this.tokenCounter.count(output);
        compressed.push({
          toolCallId: r.id ?? "",
          toolName: r.tool,
          compressedContent: output,
          originalTokens,
          compressedTokens: outputTokens,
          ratio: originalTokens ? outputTokens / originalTokens : 1,
          usedLlm: false,
          preserved: false,
          fullResultAvailable: Boolean(r.id),
        });
        totalOriginal += originalTokens;
        totalCompressed += outputTokens;
        continue;
      }

      // Tier 2: LLM summarization (if available and above threshold)
      if (
        this.config.useLlmSummarization &&
        llmCaller &&
        originalTokens >= this.config.llmSummarizeThreshold
      ) {
        try {
          const summary = await this.llmSummarize(content, r.tool, llmCaller);
          const output = this.withPreservedContext(r.result, summary, r.id);
          const summaryTokens = this.tokenCounter.count(output);

          compressed.push({
            toolCallId: r.id ?? "",
            toolName: r.tool,
            compressedContent: output,
            originalTokens,
            compressedTokens: summaryTokens,
            ratio: summaryTokens / originalTokens,
            usedLlm: true,
            preserved: false,
            fullResultAvailable: Boolean(r.id),
          });
          totalOriginal += originalTokens;
          totalCompressed += summaryTokens;
          llmCount++;
          continue;
        } catch {
          // Fall through to SmartCrusher result on LLM failure
        }
      }

      // Fallback: Use SmartCrusher result (best we can do without LLM)
      const output = this.withPreservedContext(r.result, crushResult.compressed, r.id);
      const outputTokens = this.tokenCounter.count(output);
      compressed.push({
        toolCallId: r.id ?? "",
        toolName: r.tool,
        compressedContent: output,
        originalTokens,
        compressedTokens: outputTokens,
        ratio: originalTokens ? outputTokens / originalTokens : 1,
        usedLlm: false,
        preserved: false,
        fullResultAvailable: Boolean(r.id),
      });
      totalOriginal += originalTokens;
      totalCompressed += outputTokens;
    }

    // Enforce max results in prompt (drop oldest if over limit)
    const trimmed = this.enforceMaxResults(compressed);

    // Update stats
    this.stats.totalResults += results.length;
    this.stats.compressedResults += results.length - preservedCount;
    this.stats.preservedResults += preservedCount;
    this.stats.llmSummarizedResults += llmCount;
    this.stats.totalOriginalTokens += totalOriginal;
    this.stats.totalCompressedTokens += totalCompressed;
    this.stats.averageRatio = this.stats.totalOriginalTokens > 0
      ? this.stats.totalCompressedTokens / this.stats.totalOriginalTokens
      : 1;

    return trimmed;
  }

  /**
   * Build message entries for prompt injection from compressed results.
   */
  buildPromptMessages(compressed: CompressedToolResult[]): Array<{
    role: "tool";
    tool_call_id: string;
    content: string;
  }> {
    return compressed.map(r => ({
      role: "tool" as const,
      tool_call_id: r.toolCallId,
      content: this.formatForPrompt(r),
    }));
  }

  /**
   * Get compression statistics.
   */
  getStats(): CompressionStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): CompressionStats {
    return {
      totalResults: 0,
      compressedResults: 0,
      preservedResults: 0,
      llmSummarizedResults: 0,
      totalOriginalTokens: 0,
      totalCompressedTokens: 0,
      averageRatio: 1,
    };
  }

  /**
   * Get the scale factor for compression aggressiveness based on context window.
   *
   * Smaller context windows → more aggressive compression.
   *   < 32K tokens: 0.5x (very aggressive)
   *   < 64K tokens: 0.7x
   *   < 128K tokens: 0.85x
   *   >= 128K tokens: 1.0x (normal)
   */
  private getAggressivenessScale(): number {
    const cw = this.config.contextWindow;
    if (cw < 32000) return 0.5;
    if (cw < 64000) return 0.7;
    if (cw < 128000) return 0.85;
    return 1.0;
  }

  /**
   * LLM summarization (Tier 2).
   */
  private async llmSummarize(
    content: string,
    toolName: string,
    llmCaller: (prompt: string) => Promise<string>,
  ): Promise<string> {
    const scale = this.getAggressivenessScale();
    const targetTokens = Math.floor(this.config.maxToolResultTokens * scale);

    const prompt = `Summarize this ${toolName} tool result concisely.
Keep: key data points, errors, status, actionable items.
Remove: verbose formatting, redundant info, implementation details.
Target: ~${targetTokens} tokens.

TOOL RESULT:
${content.slice(0, 8000)}

SUMMARY:`;

    const summary = await llmCaller(prompt);

    // Validate summary is shorter
    const summaryTokens = this.tokenCounter.count(summary);
    if (summaryTokens > this.config.maxToolResultTokens * 1.5) {
      // Summary too long, fall back to SmartCrusher
      throw new Error("LLM summary too long");
    }

    return summary;
  }

  /**
   * Preserve result as-is (under threshold).
   */
  private preserveAsIs(r: {
    tool: string;
    args: Record<string, unknown>;
    result: ToolResult;
    id?: string;
  }): CompressedToolResult {
    const content = this.extractContent(r.result);
    const tokens = this.tokenCounter.count(content);
    return {
      toolCallId: r.id ?? "",
      toolName: r.tool,
      compressedContent: content,
      originalTokens: tokens,
      compressedTokens: tokens,
      ratio: 1,
      usedLlm: false,
      preserved: true,
    };
  }

  /**
   * Extract text content from a ToolResult.
   */
  private extractContent(result: ToolResult): string {
    let content = typeof result.data === "string"
      ? result.data
      : result.data && typeof result.data === "object"
        ? JSON.stringify(result.data, null, 2)
        : result.success ? "OK" : "";
    if (!result.success || result.error) content = `ERROR: ${result.error ?? "unspecified error"}\n${content}`;
    if (result.artifacts !== undefined) content += `\nArtifacts: ${JSON.stringify(result.artifacts)}`;
    if (result.stdout) content += `\nstdout:\n${result.stdout}`;
    if (result.stderr) content += `\nstderr:\n${result.stderr}`;
    if (result.truncated) content += "\n[tool output was truncated; full output may be available through the tool result retriever]";
    return content;
  }

  /** Collapse exact repeated lines before deterministic crushing, retaining a count. */
  private collapseRepeatedLines(content: string): string {
    const lines = content.split("\n");
    const output: string[] = [];
    for (let i = 0; i < lines.length;) {
      let end = i + 1;
      while (end < lines.length && lines[end] === lines[i]) end++;
      const count = end - i;
      output.push(lines[i]);
      if (count > 1) output.push(`[repeated identical line ${count - 1} more time${count === 2 ? "" : "s"}]`);
      i = end;
    }
    return output.join("\n");
  }

  /** Preserve failure details and compact, high-value evidence/provenance fields. */
  private withPreservedContext(result: ToolResult, compressed: string, toolCallId?: string): string {
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : undefined;
    const preserved: Record<string, unknown> = {};
    for (const key of ["evidence", "provenance", "source", "venue", "asOf", "fetchedAt", "freshness", "stale", "symbol", "timeframe", "timestamp", "confidence"]) {
      if (data && Object.prototype.hasOwnProperty.call(data, key)) preserved[key] = data[key];
    }

    const header: string[] = [];
    if (!result.success) header.push(`Tool failed: ${result.error ?? "unspecified error"}`);
    else if (result.error) header.push(`Tool error: ${result.error}`);
    if (Object.keys(preserved).length > 0) header.push(`Preserved evidence/provenance: ${JSON.stringify(preserved)}`);
    if (toolCallId) header.push(`Full result retrievable with get_tool_result (tool_call_id=${toolCallId}).`);
    return header.length ? `${header.join("\n")}\n${compressed}` : compressed;
  }

  /**
   * Format compressed result for prompt injection.
   */
  private formatForPrompt(r: CompressedToolResult): string {
    const prefix = `[${r.toolName}${r.toolCallId ? ` call=${r.toolCallId}` : ""}]`;
    if (r.preserved) {
      return `${prefix} ${r.compressedContent}`;
    }
    const meta = r.usedLlm
      ? ` (llm-summarized, ${r.originalTokens}→${r.compressedTokens} tokens)`
      : ` (crushed, ${r.originalTokens}→${r.compressedTokens} tokens)`;
    return `${prefix}${meta}${r.fullResultAvailable ? ` Full output: get_tool_result(tool_call_id=${r.toolCallId}).` : ""} ${r.compressedContent}`;
  }

  /**
   * Enforce max results in prompt (drop oldest if over limit).
   */
  private enforceMaxResults(results: CompressedToolResult[]): CompressedToolResult[] {
    if (results.length <= this.config.maxResultsInPrompt) {
      return results;
    }

    // Keep most recent results (last N)
    const dropped = results.length - this.config.maxResultsInPrompt;
    const kept = results.slice(dropped);

    // Add a summary of dropped results at the beginning
    const droppedSummary: CompressedToolResult = {
      toolCallId: "dropped-summary",
      toolName: "system",
      compressedContent: `[${dropped} earlier tool results dropped to save context space]`,
      originalTokens: 0,
      compressedTokens: 0,
      ratio: 0,
      usedLlm: false,
      preserved: false,
    };

    return [droppedSummary, ...kept];
  }
}
