/**
 * Response Quality Scorer
 *
 * Scores LLM responses on four dimensions: coherence, tool usage,
 * actionability, and conciseness. Returns a weighted composite score.
 */

export interface ResponseScore {
  overall: number;      // 0-1 composite weighted score
  coherence: number;    // 0-1 structure and clarity
  toolUsage: number;    // 0-1 tool call effectiveness
  actionability: number; // 0-1 how decisive and actionable
  conciseness: number;  // 0-1 brevity vs verbosity
  details: string[];    // human-readable notes
}

const HEDGING_WORDS = [
  /\bi'?m not sure\b/i,
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bi don't know\b/i,
  /\bi do not know\b/i,
  /\bi think\b/i,
  /\bmight be\b/i,
  /\bcould be\b/i,
];

const AMBIVALENT_WORDS = /\b(however|but|although)\b/i;
const RESOLUTION_WORDS = /\b(therefore|conclusively|clearly|definitely)\b/i;

const ACTION_WORDS = /\b(executing|analyzing|fetching|placing|submitting|running|calculating|done|complete)\b/i;
const RESULT_WORDS = /\b(result|value|price|amount|percentage|total|summary|status)\b/i;
const FILLER_WORDS = /\b(um|uh)\b/i;
const FILLER_PHRASES = /\b(well you know|sort of|kind of)\b/i;

export class QualityScorer {
  score(
    response: string,
    toolCalls: Array<{ tool: string; args?: Record<string, unknown> }>,
  ): ResponseScore {
    const details: string[] = [];

    const coherence = this.scoreCoherence(response, details);
    const toolUsage = this.scoreToolUsage(toolCalls, details);
    const actionability = this.scoreActionability(response, toolCalls, details);
    const conciseness = this.scoreConciseness(response, details);

    const overall =
      coherence * 0.25 + toolUsage * 0.30 + actionability * 0.30 + conciseness * 0.15;

    return {
      overall: clamp01(overall),
      coherence,
      toolUsage,
      actionability,
      conciseness,
      details,
    };
  }

  private scoreCoherence(text: string, details: string[]): number {
    let score = 0.5;

    // Paragraph breaks
    if (text.includes("\n\n")) {
      score += 0.1;
      details.push("+0.1 coherence: paragraph breaks detected");
    }

    // Lists
    if (/^-\s/m.test(text) || /^\d+\.\s/m.test(text)) {
      score += 0.1;
      details.push("+0.1 coherence: lists detected");
    }

    // Hedging penalties
    let hedgingDeductions = 0;
    for (const pattern of HEDGING_WORDS) {
      const matches = text.match(pattern);
      if (matches) {
        const count = matches.length;
        for (let i = 0; i < count && hedgingDeductions < 0.3; i++) {
          hedgingDeductions += 0.1;
        }
      }
    }
    if (hedgingDeductions > 0) {
      score -= hedgingDeductions;
      details.push(`-${hedgingDeductions.toFixed(1)} coherence: hedging language`);
    }

    // Ambivalent without resolution
    const hasAmbivalent = AMBIVALENT_WORDS.test(text);
    const hasResolution = RESOLUTION_WORDS.test(text);
    if (hasAmbivalent && !hasResolution) {
      score -= 0.1;
      details.push("-0.1 coherence: ambivalent language without resolution");
    }

    return clamp01(score);
  }

  private scoreToolUsage(
    toolCalls: Array<{ tool: string; args?: Record<string, unknown> }>,
    details: string[],
  ): number {
    const count = toolCalls.length;
    if (count === 0) {
      details.push("0.2 toolUsage: no tools used");
      return 0.2;
    }

    let score = 0.4;
    details.push(`0.4 toolUsage: ${count} tool call(s) detected`);

    // +0.1 per tool call up to +0.3 (max 3 tools)
    const callBonus = Math.min(count, 3) * 0.1;
    if (callBonus > 0) {
      score += callBonus;
      details.push(`+${callBonus.toFixed(1)} toolUsage: call count bonus`);
    }

    // Diversity: more than 1 unique tool
    const uniqueTools = new Set(toolCalls.map((tc) => tc.tool));
    if (uniqueTools.size > 1) {
      score += 0.2;
      details.push("+0.2 toolUsage: diverse tool usage");
    }

    // Repetition penalty: single tool with >3 calls
    if (uniqueTools.size === 1 && count > 3) {
      score -= 0.2;
      details.push("-0.2 toolUsage: repetitive single-tool usage");
    }

    // Sweet spot 2-5 total calls
    if (count >= 2 && count <= 5) {
      score += 0.1;
      details.push("+0.1 toolUsage: sweet spot (2-5 calls)");
    }

    return clamp01(score);
  }

  private scoreActionability(
    text: string,
    toolCalls: Array<{ tool: string; args?: Record<string, unknown> }>,
    details: string[],
  ): number {
    let score = 0.3;

    // Tool call bonus
    if (toolCalls.length > 0) {
      score += 0.3;
      details.push("+0.3 actionability: tool calls present");
    }

    // Action words
    const actionMatch = text.match(ACTION_WORDS);
    if (actionMatch) {
      score += 0.2;
      details.push("+0.2 actionability: action words detected");
    }

    // Result words
    const resultMatch = text.match(RESULT_WORDS);
    if (resultMatch) {
      score += 0.1;
      details.push("+0.1 actionability: result words detected");
    }

    // Filler penalties
    let fillerDeductions = 0;
    const fillerMatches = text.match(FILLER_WORDS);
    if (fillerMatches) {
      fillerDeductions += Math.min(fillerMatches.length * 0.05, 0.2);
    }
    const phraseMatches = text.match(FILLER_PHRASES);
    if (phraseMatches) {
      fillerDeductions += Math.min(phraseMatches.length * 0.05, 0.2);
    }
    fillerDeductions = Math.min(fillerDeductions, 0.2);
    if (fillerDeductions > 0) {
      score -= fillerDeductions;
      details.push(`-${fillerDeductions.toFixed(2)} actionability: filler language`);
    }

    return clamp01(score);
  }

  private scoreConciseness(text: string, details: string[]): number {
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    let score = 0.5;

    details.push(`Conciseness: ${wordCount} word(s)`);

    // Very short penalty
    if (wordCount < 10 && wordCount > 0) {
      score -= 0.2;
      details.push("-0.2 conciseness: too brief (<10 words)");
    }

    // Sweet spot bonus
    if (wordCount >= 20 && wordCount <= 100) {
      score += 0.2;
      details.push("+0.2 conciseness: sweet spot (20-100 words)");
    }

    // Verbosity penalty
    if (wordCount > 200) {
      const penalty = Math.min(0.4, (wordCount - 200) / 500);
      score -= penalty;
      details.push(`-${penalty.toFixed(2)} conciseness: verbose (>200 words)`);
    }

    return clamp01(score);
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
