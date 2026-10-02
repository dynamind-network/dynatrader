/**
 * Tests for InteractivePrompts
 *
 * Tests cover:
 * - Question creation for all types (single-choice, multi-choice, approval, confirmation)
 * - Option rendering as button definitions
 * - Response mapping back to questions
 * - Expiration enforcement
 * - Audit event recording
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { InteractivePrompts } from "./interactive-prompts";

// Mock AuditTrail
const mockRecord = vi.fn();
vi.mock("@dyna/audit", () => ({
  AuditTrail: vi.fn().mockImplementation(() => ({
    record: mockRecord,
  })),
}));

describe("InteractivePrompts", () => {
  let prompts: InteractivePrompts;

  beforeEach(() => {
    vi.clearAllMocks();
    prompts = new InteractivePrompts({
      workspacePath: "/tmp/test-workspace",
      defaultTTLMs: 60_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Question Creation ───────────────────────────────────────

  describe("createQuestion", () => {
    it("should create a single-choice question with options", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "What is your risk tolerance?",
        options: [
          { label: "Low", value: "low", requiresApproval: false },
          { label: "Medium", value: "medium", requiresApproval: false },
          { label: "High", value: "high", requiresApproval: true },
        ],
        ttlMs: 30_000,
      });

      expect(question.id).toBeDefined();
      expect(question.id.length).toBeGreaterThan(0);
      expect(question.type).toBe("single-choice");
      expect(question.text).toBe("What is your risk tolerance?");
      expect(question.options).toHaveLength(3);
      expect(question.options[0]).toEqual({
        label: "Low",
        value: "low",
        requiresApproval: false,
      });
      expect(question.expiresAt).toBeInstanceOf(Date);
      expect(question.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("should create a multi-choice question", () => {
      const question = prompts.createQuestion({
        type: "multi-choice",
        text: "Which indicators would you like?",
        options: [
          { label: "RSI", value: "rsi", requiresApproval: false },
          { label: "MACD", value: "macd", requiresApproval: false },
          { label: "Bollinger Bands", value: "bb", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      expect(question.type).toBe("multi-choice");
      expect(question.options).toHaveLength(3);
    });

    it("should create an approval prompt", () => {
      const question = prompts.createQuestion({
        type: "approval",
        text: "Approve trade: Buy 0.1 BTC at market?",
        options: [
          { label: "Approve", value: "approve", requiresApproval: false },
          { label: "Reject", value: "reject", requiresApproval: false },
        ],
        ttlMs: 15_000,
      });

      expect(question.type).toBe("approval");
      expect(question.options).toHaveLength(2);
    });

    it("should create a confirmation prompt", () => {
      const question = prompts.createQuestion({
        type: "confirmation",
        text: "Confirm you want to proceed?",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
          { label: "No", value: "no", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      expect(question.type).toBe("confirmation");
      expect(question.options).toHaveLength(2);
    });

    it("should use default TTL when not specified", () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Test default TTL?",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
        ],
      });

      const expectedExpiry = now + 60_000;
      expect(question.expiresAt.getTime()).toBe(expectedExpiry);
    });

    it("should record an audit event on question creation", () => {
      prompts.createQuestion({
        type: "single-choice",
        text: "Audit test?",
        options: [
          { label: "A", value: "a", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "decision",
          action: "question_created",
          result: "success",
        })
      );
    });
  });

  // ─── Render Buttons ─────────────────────────────────────────

  describe("renderButtons", () => {
    it("should render options as button definitions", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Pick one:",
        options: [
          { label: "Option A", value: "a", requiresApproval: false },
          { label: "Option B", value: "b", requiresApproval: true },
        ],
        ttlMs: 30_000,
      });

      const buttons = prompts.renderButtons(question.id);

      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toEqual({
        text: "Option A",
        callbackData: expect.stringContaining("a"),
        style: "default",
      });
      expect(buttons[1]).toEqual({
        text: "Option B",
        callbackData: expect.stringContaining("b"),
        style: "danger",
      });
    });

    it("should throw for non-existent question", () => {
      expect(() => prompts.renderButtons("non-existent-id")).toThrow(
        /not found/i
      );
    });
  });

  // ─── Record Response ────────────────────────────────────────

  describe("recordResponse", () => {
    it("should record a response for a question", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Proceed?",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
          { label: "No", value: "no", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      const response = prompts.recordResponse({
        questionId: question.id,
        selectedValues: ["yes"],
        respondentId: "user-123",
      });

      expect(response.questionId).toBe(question.id);
      expect(response.selectedValues).toEqual(["yes"]);
      expect(response.respondentId).toBe("user-123");
      expect(response.respondedAt).toBeInstanceOf(Date);
    });

    it("should reject a response to an expired question", () => {
      vi.useFakeTimers();

      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Quick question?",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
        ],
        ttlMs: 10_000,
      });

      // Advance time past expiry
      vi.advanceTimersByTime(15_000);

      expect(() =>
        prompts.recordResponse({
          questionId: question.id,
          selectedValues: ["yes"],
          respondentId: "user-123",
        })
      ).toThrow(/expired/i);
    });

    it("should reject a response with invalid option values", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Pick one:",
        options: [
          { label: "A", value: "a", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      expect(() =>
        prompts.recordResponse({
          questionId: question.id,
          selectedValues: ["invalid-value"],
          respondentId: "user-123",
        })
      ).toThrow(/invalid/i);
    });

    it("should reject multiple selections for single-choice", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Pick one:",
        options: [
          { label: "A", value: "a", requiresApproval: false },
          { label: "B", value: "b", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      expect(() =>
        prompts.recordResponse({
          questionId: question.id,
          selectedValues: ["a", "b"],
          respondentId: "user-123",
        })
      ).toThrow(/single/i);
    });

    it("should record audit event on response", () => {
      const question = prompts.createQuestion({
        type: "approval",
        text: "Approve?",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
          { label: "No", value: "no", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      mockRecord.mockClear();

      prompts.recordResponse({
        questionId: question.id,
        selectedValues: ["yes"],
        respondentId: "user-123",
      });

      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "decision",
          action: "question_responded",
          result: "success",
        })
      );
    });

    it("should reject a question that has already been answered", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "One-time question?",
        options: [
          { label: "A", value: "a", requiresApproval: false },
          { label: "B", value: "b", requiresApproval: false },
        ],
        ttlMs: 60_000,
      });

      prompts.recordResponse({
        questionId: question.id,
        selectedValues: ["a"],
        respondentId: "user-123",
      });

      expect(() =>
        prompts.recordResponse({
          questionId: question.id,
          selectedValues: ["b"],
          respondentId: "user-123",
        })
      ).toThrow(/already/i);
    });
  });

  // ─── Get Question ───────────────────────────────────────────

  describe("getQuestion", () => {
    it("should return a question by ID", () => {
      const created = prompts.createQuestion({
        type: "single-choice",
        text: "Find me!",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      const found = prompts.getQuestion(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.text).toBe("Find me!");
    });

    it("should return undefined for unknown question", () => {
      const found = prompts.getQuestion("unknown-id");
      expect(found).toBeUndefined();
    });
  });

  // ─── Get Response ────────────────────────────────────────────

  describe("getResponse", () => {
    it("should return the response for a question", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Response test?",
        options: [
          { label: "A", value: "a", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      prompts.recordResponse({
        questionId: question.id,
        selectedValues: ["a"],
        respondentId: "user-123",
      });

      const response = prompts.getResponse(question.id);
      expect(response).toBeDefined();
      expect(response!.selectedValues).toEqual(["a"]);
    });

    it("should return undefined when question has no response", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "No response yet?",
        options: [
          { label: "A", value: "a", requiresApproval: false },
        ],
        ttlMs: 30_000,
      });

      const response = prompts.getResponse(question.id);
      expect(response).toBeUndefined();
    });
  });

  // ─── Is Expired ─────────────────────────────────────────────

  describe("isExpired", () => {
    it("should return false for a fresh question", () => {
      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Fresh?",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
        ],
        ttlMs: 60_000,
      });

      expect(prompts.isExpired(question.id)).toBe(false);
    });

    it("should return true for an expired question", () => {
      vi.useFakeTimers();

      const question = prompts.createQuestion({
        type: "single-choice",
        text: "Will expire?",
        options: [
          { label: "Yes", value: "yes", requiresApproval: false },
        ],
        ttlMs: 10_000,
      });

      vi.advanceTimersByTime(15_000);

      expect(prompts.isExpired(question.id)).toBe(true);
    });

    it("should throw for a non-existent question", () => {
      expect(() => prompts.isExpired("ghost")).toThrow(/not found/i);
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle a question with no options", () => {
      expect(() =>
        prompts.createQuestion({
          type: "single-choice",
          text: "No options?",
          options: [],
          ttlMs: 30_000,
        })
      ).toThrow(/option/i);
    });

    it("should handle question with metadata", () => {
      const question = prompts.createQuestion({
        type: "confirmation",
        text: "With metadata?",
        options: [
          { label: "OK", value: "ok", requiresApproval: false },
        ],
        ttlMs: 30_000,
        metadata: { strategyId: "strat-001", symbol: "BTC/USDT" },
      });

      expect(question.metadata).toEqual({
        strategyId: "strat-001",
        symbol: "BTC/USDT",
      });
    });
  });
});
