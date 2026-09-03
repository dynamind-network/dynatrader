/**
 * Error Classifier - Categorizes LLM provider errors into structured types.
 *
 * Provides classification with severity levels and recovery hints
 * so the RecoveryManager can take appropriate action per error type.
 */

export enum ErrorCategory {
  RATE_LIMIT = "rate_limit",
  AUTH = "auth",
  TIMEOUT = "timeout",
  SERVER_ERROR = "server_error",
  CONTEXT_OVERFLOW = "context_overflow",
  INVALID_REQUEST = "invalid_request",
  UNKNOWN = "unknown",
}

export enum ErrorSeverity {
  TRANSIENT = "transient",
  RECOVERABLE = "recoverable",
  FATAL = "fatal",
}

export interface ClassifiedError {
  category: ErrorCategory;
  severity: ErrorSeverity;
  retryable: boolean;
  suggestedWaitMs: number;
  recoveryHint: string;
}

const RATE_LIMIT_DEFAULT_WAIT_MS = 5_000;

/** Extract a numeric wait time from rate-limit messages like "retry after 30s" or "retry after 15 seconds". */
function parseSuggestedWaitMs(message: string): number {
  const secondsMatch = message.match(/retry\s+after\s+(\d+)\s*s(?:econds?)?/i);
  if (secondsMatch) {
    return parseInt(secondsMatch[1]!, 10) * 1_000;
  }
  return 0;
}

export class ErrorClassifier {
  classify(error: Error): ClassifiedError {
    const message = error.message ?? "";

    // --- Rate Limit (429, rate_limit) ---
    if (
      /^429\b/.test(message) ||
      /\brate[_ ]limit/i.test(message)
    ) {
      const explicitWait = parseSuggestedWaitMs(message);
      return {
        category: ErrorCategory.RATE_LIMIT,
        severity: ErrorSeverity.TRANSIENT,
        retryable: true,
        suggestedWaitMs: explicitWait > 0 ? explicitWait : RATE_LIMIT_DEFAULT_WAIT_MS,
        recoveryHint: "Retry after the suggested wait period. If rate limits persist, reduce request frequency or increase your quota.",
      };
    }

    // --- Auth (401, 403, unauthorized, forbidden) ---
    if (
      /^40[13]\b/.test(message) ||
      /\bunauthorized\b/i.test(message) ||
      /\bauthentication\b/i.test(message) ||
      /\binvalid\s+api\s*key\b/i.test(message) ||
      /\bforbidden\b/i.test(message)
    ) {
      return {
        category: ErrorCategory.AUTH,
        severity: ErrorSeverity.FATAL,
        retryable: false,
        suggestedWaitMs: 0,
        recoveryHint: "Check your API key and authentication credentials. This error will not resolve with retries.",
      };
    }

    // --- Timeout (timeout, ETIMEDOUT) ---
    if (
      /\btimeout\b/i.test(message) ||
      /\btimed\s*out\b/i.test(message) ||
      /\bETIMEDOUT\b/i.test(message)
    ) {
      return {
        category: ErrorCategory.TIMEOUT,
        severity: ErrorSeverity.TRANSIENT,
        retryable: true,
        suggestedWaitMs: 0,
        recoveryHint: "The request timed out. Retry with a longer timeout or check network connectivity.",
      };
    }

    // --- Server Error (5xx, server_error) ---
    if (
      /^5\d{2}\b/.test(message) ||
      /\bserver[_ ]error\b/i.test(message) ||
      /\binternal\s+server\s+error\b/i.test(message) ||
      /\bbad\s+gateway\b/i.test(message) ||
      /\bservice\s+unavailable\b/i.test(message)
    ) {
      return {
        category: ErrorCategory.SERVER_ERROR,
        severity: ErrorSeverity.TRANSIENT,
        retryable: true,
        suggestedWaitMs: 0,
        recoveryHint: "The provider returned a server error. Retry with exponential backoff.",
      };
    }

    // --- Context Overflow (context_length_exceeded) ---
    if (
      /\bcontext_length_exceeded\b/i.test(message) ||
      /\bcontext\s+length\b/i.test(message) ||
      /\bcontext\s+overflow\b/i.test(message) ||
      /\bmaximum\s+context\s+length\b/i.test(message)
    ) {
      return {
        category: ErrorCategory.CONTEXT_OVERFLOW,
        severity: ErrorSeverity.RECOVERABLE,
        retryable: true,
        suggestedWaitMs: 0,
        recoveryHint: "Reduce the conversation context (trim messages, summarize) or use a model with a larger context window.",
      };
    }

    // --- Invalid Request (other 4xx, invalid_request) ---
    if (
      /^4\d{2}\b/.test(message) ||
      /\binvalid_request/i.test(message) ||
      /\binvalid\s+request\b/i.test(message) ||
      /\bbad\s+request\b/i.test(message)
    ) {
      return {
        category: ErrorCategory.INVALID_REQUEST,
        severity: ErrorSeverity.FATAL,
        retryable: false,
        suggestedWaitMs: 0,
        recoveryHint: "The request was invalid. Check the request parameters and payload before retrying.",
      };
    }

    // --- Unknown (fallback) ---
    return {
      category: ErrorCategory.UNKNOWN,
      severity: ErrorSeverity.TRANSIENT,
      retryable: true,
      suggestedWaitMs: 0,
      recoveryHint: "An unexpected error occurred. Retry may resolve the issue.",
    };
  }
}
