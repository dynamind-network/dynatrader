/**
 * Tool Call Parser - Handles array-only format.
 *
 * Uses GBNF grammar to enforce:
 *   [{tool: "name", args: {...}}, ...]
 *
 * This parser handles both:
 *   1. Standard OpenAI format: {tool_calls: [{function: {name, arguments}}]}
 *   2. Array-only format: [{tool: "name", args: {...}}]
 *
 * The array-only format is more efficient for small models:
 *   - Single inference produces all tool calls
 *   - No nesting overhead
 *   - Grammar-constrained validity
 */

import type { ToolCall } from "@dyna/contracts";

export interface ToolCallPayload {
  /** Tool name */
  tool: string;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** Optional ID for correlation */
  id?: string;
}

export interface ParseResult {
  /** Parsed tool calls */
  calls: ToolCallPayload[];
  /** Whether this was an array-only format */
  isArrayFormat: boolean;
  /** Any reasoning text before the tool calls */
  reasoning?: string;
  /** Parse error if any */
  error?: string;
}

/**
 * Parse tool calls from model response content.
 *
 * Handles:
 *   - Standard OpenAI tool_calls array
 *   - Array-only format [{tool, args}, ...]
 *   - JSON code blocks with tool calls
 *   - Plain text with embedded JSON
 */
export function parseToolCallArray(
  content: string | null | undefined,
  toolCalls?: Array<{
    id?: string;
    function: { name: string; arguments: string };
  }>,
): ParseResult {
  // If OpenAI tool_calls are provided, use them directly
  if (toolCalls && toolCalls.length > 0) {
    return {
      calls: toolCalls.map((tc, i) => ({
        tool: tc.function.name,
        args: safeParseJson(tc.function.arguments),
        id: tc.id ?? `tc-${i}`,
      })),
      isArrayFormat: false,
    };
  }

  // Try to parse from content
  if (!content) {
    return { calls: [], isArrayFormat: false, error: "No content to parse" };
  }

  // Try to extract JSON from content
  const jsonResult = extractJsonArray(content);
  if (jsonResult) {
    return {
      calls: jsonResult,
      isArrayFormat: true,
    };
  }

  return { calls: [], isArrayFormat: false, error: "No tool calls found in content" };
}

/**
 * Extract a JSON array of tool calls from content.
 *
 * Handles:
 *   - Direct JSON arrays: [{...}]
 *   - Code blocks: ```json\n[{...}]\n```
 *   - Text with embedded JSON
 */
function extractJsonArray(content: string): ToolCallPayload[] | null {
  // Try direct parse first
  const trimmed = content.trim();
  if (trimmed.startsWith("[")) {
    const parsed = tryParseJsonArray(trimmed);
    if (parsed) return parsed;
  }

  // Try code block extraction
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const parsed = tryParseJsonArray(codeBlockMatch[1].trim());
    if (parsed) return parsed;
  }

  // Try to find array in text
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const parsed = tryParseJsonArray(arrayMatch[0]);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Try to parse a JSON array of tool calls.
 */
function tryParseJsonArray(json: string): ToolCallPayload[] | null {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter((item: unknown): item is ToolCallPayload => {
        if (typeof item !== "object" || item === null) return false;
        const obj = item as Record<string, unknown>;
        return typeof obj.tool === "string" && typeof obj.args === "object" && obj.args !== null;
      })
      .map((item: ToolCallPayload, i: number) => ({
        tool: item.tool,
        args: item.args ?? {},
        id: item.id ?? `tc-${i}`,
      }));
  } catch {
    return null;
  }
}

/**
 * Safely parse JSON, returning original string on failure.
 */
function safeParseJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Format tool calls as array-only JSON for model prompts.
 *
 * This tells the model to return tool calls in the format:
 *   [{tool: "name", args: {...}}, ...]
 */
export function formatToolCallsAsArray(
  calls: ToolCallPayload[],
): string {
  return JSON.stringify(calls, null, 2);
}

/**
 * Check if content contains a tool call array.
 */
export function isToolCallArray(content: string | null | undefined): boolean {
  if (!content) return false;
  const result = extractJsonArray(content);
  return result !== null && result.length > 0;
}
