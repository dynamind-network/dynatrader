import { describe, it, expect } from "vitest";
import { ErrorClassifier, ErrorCategory, ErrorSeverity } from "./error-classifier";

describe("ErrorClassifier", () => {
  const classifier = new ErrorClassifier();

  describe("rate limit errors", () => {
    it("classifies 429 Too Many Requests as RATE_LIMIT", () => {
      const result = classifier.classify(new Error("429 Too Many Requests"));
      expect(result.category).toBe(ErrorCategory.RATE_LIMIT);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it("classifies rate limit message as RATE_LIMIT", () => {
      const result = classifier.classify(new Error("Rate limit exceeded. Please try again later."));
      expect(result.category).toBe(ErrorCategory.RATE_LIMIT);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it("classifies rate_limit error code as RATE_LIMIT", () => {
      const result = classifier.classify(new Error("rate_limit: API quota exhausted"));
      expect(result.category).toBe(ErrorCategory.RATE_LIMIT);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });
  });

  describe("auth errors", () => {
    it("classifies 401 Invalid API key as AUTH", () => {
      const result = classifier.classify(new Error("401 Invalid API key"));
      expect(result.category).toBe(ErrorCategory.AUTH);
      expect(result.severity).toBe(ErrorSeverity.FATAL);
      expect(result.retryable).toBe(false);
    });

    it("classifies 403 Forbidden as AUTH", () => {
      const result = classifier.classify(new Error("403 Forbidden: insufficient permissions"));
      expect(result.category).toBe(ErrorCategory.AUTH);
      expect(result.severity).toBe(ErrorSeverity.FATAL);
      expect(result.retryable).toBe(false);
    });

    it("classifies unauthorized error as AUTH", () => {
      const result = classifier.classify(new Error("Unauthorized: invalid API key provided"));
      expect(result.category).toBe(ErrorCategory.AUTH);
      expect(result.severity).toBe(ErrorSeverity.FATAL);
      expect(result.retryable).toBe(false);
    });

    it("classifies authentication error as AUTH", () => {
      const result = classifier.classify(new Error("Authentication failed: token expired"));
      expect(result.category).toBe(ErrorCategory.AUTH);
      expect(result.severity).toBe(ErrorSeverity.FATAL);
      expect(result.retryable).toBe(false);
    });
  });

  describe("timeout errors", () => {
    it("classifies ETIMEDOUT as TIMEOUT", () => {
      const result = classifier.classify(new Error("ETIMEDOUT"));
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it("classifies timeout message as TIMEOUT", () => {
      const result = classifier.classify(new Error("timeout of 30000ms exceeded"));
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it("classifies connection timed out as TIMEOUT", () => {
      const result = classifier.classify(new Error("Connection timed out"));
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });
  });

  describe("server errors", () => {
    it("classifies 500 Internal Server Error as SERVER_ERROR", () => {
      const result = classifier.classify(new Error("500 Internal Server Error"));
      expect(result.category).toBe(ErrorCategory.SERVER_ERROR);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it("classifies 502 Bad Gateway as SERVER_ERROR", () => {
      const result = classifier.classify(new Error("502 Bad Gateway"));
      expect(result.category).toBe(ErrorCategory.SERVER_ERROR);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it("classifies 503 Service Unavailable as SERVER_ERROR", () => {
      const result = classifier.classify(new Error("503 Service Unavailable"));
      expect(result.category).toBe(ErrorCategory.SERVER_ERROR);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it("classifies server error message as SERVER_ERROR", () => {
      const result = classifier.classify(new Error("server_error: upstream failure"));
      expect(result.category).toBe(ErrorCategory.SERVER_ERROR);
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
      expect(result.retryable).toBe(true);
    });
  });

  describe("context overflow errors", () => {
    it("classifies context_length_exceeded as CONTEXT_OVERFLOW", () => {
      const result = classifier.classify(new Error("context_length_exceeded"));
      expect(result.category).toBe(ErrorCategory.CONTEXT_OVERFLOW);
      expect(result.severity).toBe(ErrorSeverity.RECOVERABLE);
      expect(result.retryable).toBe(true);
    });

    it("classifies maximum context length error as CONTEXT_OVERFLOW", () => {
      const result = classifier.classify(new Error("This model's maximum context length is 8192 tokens"));
      expect(result.category).toBe(ErrorCategory.CONTEXT_OVERFLOW);
      expect(result.severity).toBe(ErrorSeverity.RECOVERABLE);
      expect(result.retryable).toBe(true);
    });

    it("classifies context overflow message as CONTEXT_OVERFLOW", () => {
      const result = classifier.classify(new Error("context length exceeded"));
      expect(result.category).toBe(ErrorCategory.CONTEXT_OVERFLOW);
      expect(result.severity).toBe(ErrorSeverity.RECOVERABLE);
      expect(result.retryable).toBe(true);
    });
  });

  describe("invalid request errors", () => {
    it("classifies 400 Bad Request as INVALID_REQUEST", () => {
      const result = classifier.classify(new Error("400 Bad Request: invalid parameter"));
      expect(result.category).toBe(ErrorCategory.INVALID_REQUEST);
      expect(result.severity).toBe(ErrorSeverity.FATAL);
      expect(result.retryable).toBe(false);
    });

    it("classifies 422 Unprocessable Entity as INVALID_REQUEST", () => {
      const result = classifier.classify(new Error("422 Unprocessable Entity"));
      expect(result.category).toBe(ErrorCategory.INVALID_REQUEST);
      expect(result.severity).toBe(ErrorSeverity.FATAL);
      expect(result.retryable).toBe(false);
    });

    it("classifies invalid_request_error as INVALID_REQUEST", () => {
      const result = classifier.classify(new Error("invalid_request_error: unknown parameter"));
      expect(result.category).toBe(ErrorCategory.INVALID_REQUEST);
      expect(result.severity).toBe(ErrorSeverity.FATAL);
      expect(result.retryable).toBe(false);
    });
  });

  describe("unknown errors", () => {
    it("classifies unknown error as UNKNOWN", () => {
      const result = classifier.classify(new Error("something completely unexpected"));
      expect(result.category).toBe(ErrorCategory.UNKNOWN);
    });

    it("unknown errors are retryable (transient by default)", () => {
      const result = classifier.classify(new Error("random network glitch"));
      expect(result.retryable).toBe(true);
    });

    it("unknown errors have TRANSIENT severity", () => {
      const result = classifier.classify(new Error("unexpected error occurred"));
      expect(result.severity).toBe(ErrorSeverity.TRANSIENT);
    });
  });

  describe("suggestedWaitMs", () => {
    it("rate limit with explicit retry-after seconds parses wait time", () => {
      const result = classifier.classify(new Error("429 retry after 30s"));
      expect(result.suggestedWaitMs).toBe(30_000);
    });

    it("rate limit with retry-after seconds message parses wait time", () => {
      const result = classifier.classify(new Error("rate limit: retry after 15 seconds"));
      expect(result.suggestedWaitMs).toBe(15_000);
    });

    it("rate limit without explicit wait uses default wait time", () => {
      const result = classifier.classify(new Error("429 Too Many Requests"));
      expect(result.suggestedWaitMs).toBeGreaterThan(0);
    });

    it("non-rate-limit errors have suggestedWaitMs of 0", () => {
      const result = classifier.classify(new Error("500 Internal Server Error"));
      expect(result.suggestedWaitMs).toBe(0);
    });

    it("auth errors have suggestedWaitMs of 0", () => {
      const result = classifier.classify(new Error("401 Invalid API key"));
      expect(result.suggestedWaitMs).toBe(0);
    });

    it("timeout errors have suggestedWaitMs of 0", () => {
      const result = classifier.classify(new Error("ETIMEDOUT"));
      expect(result.suggestedWaitMs).toBe(0);
    });

    it("context overflow errors have suggestedWaitMs of 0", () => {
      const result = classifier.classify(new Error("context_length_exceeded"));
      expect(result.suggestedWaitMs).toBe(0);
    });
  });

  describe("recoveryHint", () => {
    it("rate limit errors provide a retry hint", () => {
      const result = classifier.classify(new Error("429 Too Many Requests"));
      expect(result.recoveryHint).toBeTruthy();
      expect(result.recoveryHint.toLowerCase()).toContain("retry");
    });

    it("auth errors provide a credential hint", () => {
      const result = classifier.classify(new Error("401 Invalid API key"));
      expect(result.recoveryHint).toBeTruthy();
      expect(result.recoveryHint.toLowerCase()).toContain("api key");
    });

    it("unknown errors provide a generic hint", () => {
      const result = classifier.classify(new Error("weird error happened"));
      expect(result.recoveryHint).toBeTruthy();
    });
  });
});
