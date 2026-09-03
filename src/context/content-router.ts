import type { ContentRoute } from '@dyna/contracts';
import { ContentType } from '@dyna/contracts';

/**
 * ContentRouter implements a 3-tier content detection pipeline to classify
 * text strings into content types (JSON, CODE, DIFF, LOG, ERROR, SEARCH_RESULT,
 * PLAINTEXT, UNKNOWN) with associated confidence scores.
 *
 * Detection pipeline:
 *   Tier 1 (Heuristic): JSON.parse, XML tags, markdown code fences
 *   Tier 2 (Pattern):   Diff markers, log patterns, error signatures
 *   Tier 3 (Keyword):   Programming keywords, SQL keywords, search-result patterns
 */
export class ContentRouter {
  /**
   * Classify a single text string and return a ContentRoute with the detected
   * content type, confidence score, and detection source.
   */
  classify(content: string): ContentRoute {
    const heuristicResult = this.heuristicDetect(content);
    if (heuristicResult !== null) {
      return heuristicResult;
    }

    const patternResult = this.patternDetect(content);
    if (patternResult !== null) {
      return patternResult;
    }

    return this.keywordDetect(content);
  }

  /**
   * Classify and score multiple content items. Returns an array of ContentRoute
   * results in the same order as the input.
   */
  route(items: string[]): ContentRoute[] {
    const results: ContentRoute[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      results[i] = this.classify(items[i]);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Tier 1 - Heuristic Detection (confidence 0.90 - 0.99)
  // ---------------------------------------------------------------------------

  /**
   * Attempt to detect content type through structural heuristics:
   * - Valid JSON via JSON.parse
   * - XML markup (opening/closing tags or <?xml declaration)
   * - Markdown code fences (triple backticks)
   *
   * Returns a ContentRoute if a heuristic matched, or null to continue the pipeline.
   */
  private heuristicDetect(content: string): ContentRoute | null {
    // JSON parse heuristic
    const trimmed = content.trim();
    if (trimmed.length > 0) {
      try {
        JSON.parse(trimmed);
        return {
          contentType: ContentType.JSON,
          confidence: 0.98,
          detectedBy: 'heuristic/json',
        };
      } catch {
        // Not valid JSON -- continue checking
      }
    }

    // XML heuristic: matching opening/closing tags or <?xml declaration
    const xmlTagPattern = /<[A-Za-z][^>]*>[\s\S]*?<\/[A-Za-z][^>]*>/;
    const xmlDeclPattern = /^<\?xml\s/i;
    if (xmlDeclPattern.test(trimmed) || xmlTagPattern.test(trimmed)) {
      return {
        contentType: ContentType.JSON,
        confidence: 0.90,
        detectedBy: 'heuristic/xml',
        subType: 'xml',
      };
    }

    // Markdown code fence heuristic (triple backticks)
    if (/```[\s\S]*```/.test(content)) {
      return {
        contentType: ContentType.CODE,
        confidence: 0.95,
        detectedBy: 'heuristic/codefence',
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Tier 2 - Pattern Detection (confidence 0.70 - 0.85)
  // ---------------------------------------------------------------------------

  /**
   * Detect content type through common structural patterns:
   * - Git diff markers (---, +++, @@)
   * - Log/event entries (ISO 8601 timestamps, [ERROR]/[WARN]/[INFO], ERROR:/WARNING:)
   * - Error/exception stack traces (Error:, Exception, Traceback, at , File ")
   *
   * Returns a ContentRoute if a pattern matched, or null to continue the pipeline.
   */
  private patternDetect(content: string): ContentRoute | null {
    const lines = content.split('\n');

    // Diff pattern: lines starting with ---, +++, or @@
    for (const line of lines) {
      if (/^---\s/.test(line) || /^\+\+\+\s/.test(line) || /^@@\s/.test(line)) {
        return {
          contentType: ContentType.DIFF,
          confidence: 0.85,
          detectedBy: 'pattern/diff',
        };
      }
    }

    // Log pattern: ISO 8601 timestamps or common log level markers
    if (
      /\d{4}-\d{2}-\d{2}T/.test(content) ||
      /\[ERROR\]|\[WARN\]|\[INFO\]|\[DEBUG\]|\[TRACE\]|\[FATAL\]/.test(content) ||
      /\bERROR:|WARNING:/.test(content)
    ) {
      return {
        contentType: ContentType.LOG,
        confidence: 0.75,
        detectedBy: 'pattern/log',
      };
    }

    // Error pattern: common error/exception signatures
    if (
      /\bError:/.test(content) ||
      /\bException/.test(content) ||
      /\bTraceback/.test(content) ||
      /\bat\s/.test(content) ||
      /File\s+"/.test(content)
    ) {
      return {
        contentType: ContentType.ERROR,
        confidence: 0.80,
        detectedBy: 'pattern/error',
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Tier 3 - Keyword Detection (confidence 0.40 - 0.60, fallback at 0.30)
  // ---------------------------------------------------------------------------

  /**
   * Fallback detection using lexical keyword analysis:
   * - Programming language keywords (function, const, let, var, import, export, etc.)
   * - SQL statements (SELECT, FROM, WHERE, INSERT, UPDATE, DELETE, CREATE TABLE)
   * - Search result patterns (score:, relevance:, found N results)
   * - If nothing matched, returns PLAINTEXT with low confidence.
   */
  private keywordDetect(content: string): ContentRoute {
    // Programming language keywords
    const codeKeywordPatterns = [
      /\bfunction\b/,
      /\bconst\b/,
      /\blet\b/,
      /\bvar\b/,
      /\bimport\b/,
      /\bexport\b/,
      /\bclass\b/,
      /\binterface\b/,
      /=>/,
      /\bdef\s/,
      /\bpublic static\b/,
      /\bint main\b/,
    ];

    for (const pattern of codeKeywordPatterns) {
      if (pattern.test(content)) {
        return {
          contentType: ContentType.CODE,
          confidence: 0.55,
          detectedBy: 'keyword/code',
        };
      }
    }

    // SQL keywords (typically uppercase in queries)
    const sqlPatterns = [
      /\bSELECT\b/,
      /\bFROM\b/,
      /\bWHERE\b/,
      /\bINSERT\b/,
      /\bUPDATE\b/,
      /\bDELETE\b/,
      /\bCREATE TABLE\b/,
    ];

    for (const pattern of sqlPatterns) {
      if (pattern.test(content)) {
        return {
          contentType: ContentType.CODE,
          confidence: 0.50,
          detectedBy: 'keyword/sql',
        };
      }
    }

    // Search result patterns
    if (
      /\bscore:/.test(content) ||
      /\brelevance:/.test(content) ||
      /found\s+\d+\s+results/i.test(content)
    ) {
      return {
        contentType: ContentType.SEARCH_RESULT,
        confidence: 0.45,
        detectedBy: 'keyword/search',
      };
    }

    // Nothing matched -- fallback to PLAINTEXT
    return {
      contentType: ContentType.PLAINTEXT,
      confidence: 0.30,
      detectedBy: 'fallback/unknown',
    };
  }
}
