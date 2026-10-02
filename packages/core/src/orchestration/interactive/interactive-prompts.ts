/**
 * InteractivePrompts
 *
 * Question flow for multi-option questions, approval buttons,
 * and response collection. Designed for Telegram/CLI rendering.
 *
 * Features:
 * - Single-choice, multi-choice, approval, and confirmation prompt types
 * - Question expiration enforcement
 * - Button definition rendering for channel adapters
 * - Response validation and deduplication
 * - Full audit trail for question creation and responses
 */

import { v4 as uuidv4 } from "uuid";
import { AuditTrail } from "@dyna/audit";

// ─── Types ────────────────────────────────────────────────────

/** The type of interactive prompt. */
export type QuestionType =
  | "single-choice"
  | "multi-choice"
  | "approval"
  | "confirmation";

/** A single selectable option within a question. */
export interface QuestionOption {
  /** Human-readable label for the button/option. */
  label: string;
  /** Machine-readable value submitted on selection. */
  value: string;
  /** If true, selecting this option triggers an approval workflow. */
  requiresApproval: boolean;
}

/** A question artifact created by the prompts system. */
export interface Question {
  /** Unique identifier for the question. */
  id: string;
  /** The type of prompt. */
  type: QuestionType;
  /** The question text displayed to the user. */
  text: string;
  /** Available options the user can select. */
  options: QuestionOption[];
  /** Timestamp after which the question is no longer answerable. */
  expiresAt: Date;
  /** Optional metadata (e.g. strategyId, symbol, correlationId). */
  metadata?: Record<string, unknown>;
}

/** A button definition for Telegram/CLI inline keyboards. */
export interface ButtonDefinition {
  /** Button label text. */
  text: string;
  /** Callback data sent when the button is pressed. */
  callbackData: string;
  /** Visual style hint for the button. */
  style: "primary" | "danger" | "default";
}

/** A user's response to a question. */
export interface Response {
  /** The question this response answers. */
  questionId: string;
  /** The selected option value(s). */
  selectedValues: string[];
  /** Identifier of the respondent (user ID, subagent ID). */
  respondentId: string;
  /** When the response was recorded. */
  respondedAt: Date;
}

/** Configuration for InteractivePrompts. */
export interface InteractivePromptsConfig {
  /** Filesystem path used by the audit trail. */
  workspacePath: string;
  /** Default time-to-live in milliseconds for questions (default: 60_000). */
  defaultTTLMs?: number;
}

// ─── Implementation ───────────────────────────────────────────

export class InteractivePrompts {
  private questions: Map<string, Question> = new Map();
  private responses: Map<string, Response> = new Map();
  private audit: AuditTrail;
  private readonly defaultTTLMs: number;

  constructor(config: InteractivePromptsConfig) {
    this.audit = new AuditTrail(config.workspacePath);
    this.defaultTTLMs = config.defaultTTLMs ?? 60_000;
  }

  /**
   * Create a new question and return it.
   *
   * Records an audit event on creation.
   */
  createQuestion(params: {
    type: QuestionType;
    text: string;
    options: QuestionOption[];
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  }): Question {
    if (!params.options || params.options.length === 0) {
      throw new Error("Question must have at least one option");
    }

    const id = uuidv4();
    const ttlMs = params.ttlMs ?? this.defaultTTLMs;

    const question: Question = {
      id,
      type: params.type,
      text: params.text,
      options: params.options,
      expiresAt: new Date(Date.now() + ttlMs),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };

    this.questions.set(id, question);

    this.audit.record({
      type: "decision",
      actor: "system",
      actorType: "system",
      action: "question_created",
      resource: id,
      result: "success",
      details: {
        questionType: params.type,
        text: params.text,
        optionCount: params.options.length,
        ttlMs,
        metadata: params.metadata,
      },
    });

    return question;
  }

  /**
   * Render the options of a question as button definitions suitable for
   * Telegram inline keyboards, CLI prompts, or other channel adapters.
   *
   * Options with `requiresApproval: true` are rendered with `"danger"` style.
   * All others use `"default"` style. Single-choice / confirmation questions
   * get a single row of buttons; multi-choice includes a "Done" button.
   */
  renderButtons(questionId: string): ButtonDefinition[] {
    const question = this.getQuestionOrThrow(questionId);

    if (question.type === "multi-choice") {
      const choiceButtons = question.options.map((opt) => ({
        text: opt.label,
        callbackData: `q:${questionId}:${opt.value}`,
        style: (opt.requiresApproval ? "danger" : "default") as
          | "primary"
          | "danger"
          | "default",
      }));
      return [
        ...choiceButtons,
        { text: "Done", callbackData: `q:${questionId}:__done__`, style: "primary" as const },
      ];
    }

    return question.options.map((opt) => ({
      text: opt.label,
      callbackData: `q:${questionId}:${opt.value}`,
      style: (opt.requiresApproval ? "danger" : "default") as
        | "primary"
        | "danger"
        | "default",
    }));
  }

  /**
   * Record a user's response to a question.
   *
   * Validates:
   * - Question exists and has not expired.
   * - Question has not already been answered.
   * - All selected values are valid options.
   * - Single-choice questions receive exactly one value.
   *
   * Records an audit event on response.
   */
  recordResponse(params: {
    questionId: string;
    selectedValues: string[];
    respondentId: string;
  }): Response {
    const question = this.getQuestionOrThrow(params.questionId);

    // Expiry check
    if (Date.now() > question.expiresAt.getTime()) {
      this.audit.record({
        type: "decision",
        actor: params.respondentId,
        actorType: "user",
        action: "question_responded_expired",
        resource: params.questionId,
        result: "rejected",
        details: {
          reason: "Question expired",
          selectedValues: params.selectedValues,
          expiresAt: question.expiresAt.toISOString(),
        },
      });
      throw new Error(
        `Question "${params.questionId}" has expired (expired at ${question.expiresAt.toISOString()})`
      );
    }

    // Already answered check
    if (this.responses.has(params.questionId)) {
      this.audit.record({
        type: "decision",
        actor: params.respondentId,
        actorType: "user",
        action: "question_responded_duplicate",
        resource: params.questionId,
        result: "rejected",
        details: {
          reason: "Question already answered",
          selectedValues: params.selectedValues,
        },
      });
      throw new Error(
        `Question "${params.questionId}" has already been answered`
      );
    }

    // Validate option values
    const validValues = new Set(question.options.map((o) => o.value));
    for (const v of params.selectedValues) {
      if (!validValues.has(v)) {
        this.audit.record({
          type: "decision",
          actor: params.respondentId,
          actorType: "user",
          action: "question_responded_invalid",
          resource: params.questionId,
          result: "rejected",
          details: {
            reason: "Invalid option value",
            invalidValue: v,
            validOptions: [...validValues],
          },
        });
        throw new Error(
          `Invalid option value "${v}" for question "${params.questionId}". Valid options: ${[...validValues].join(", ")}`
        );
      }
    }

    // Single-choice constraint
    if (question.type === "single-choice" && params.selectedValues.length > 1) {
      this.audit.record({
        type: "decision",
        actor: params.respondentId,
        actorType: "user",
        action: "question_responded_invalid",
        resource: params.questionId,
        result: "rejected",
        details: {
          reason: "Single-choice question received multiple values",
          selectedValues: params.selectedValues,
        },
      });
      throw new Error(
        `Single-choice question "${params.questionId}" accepts only one value, but ${params.selectedValues.length} were provided`
      );
    }

    const response: Response = {
      questionId: params.questionId,
      selectedValues: params.selectedValues,
      respondentId: params.respondentId,
      respondedAt: new Date(),
    };

    this.responses.set(params.questionId, response);

    this.audit.record({
      type: "decision",
      actor: params.respondentId,
      actorType: "user",
      action: "question_responded",
      resource: params.questionId,
      result: "success",
      details: {
        questionType: question.type,
        questionText: question.text,
        selectedValues: params.selectedValues,
      },
    });

    return response;
  }

  /**
   * Retrieve a question by its ID.
   * Returns `undefined` if no question with that ID exists.
   */
  getQuestion(questionId: string): Question | undefined {
    return this.questions.get(questionId);
  }

  /**
   * Retrieve the response for a question.
   * Returns `undefined` if the question has not been answered.
   */
  getResponse(questionId: string): Response | undefined {
    return this.responses.get(questionId);
  }

  /**
   * Check whether a question has expired.
   */
  isExpired(questionId: string): boolean {
    const question = this.getQuestionOrThrow(questionId);
    return Date.now() > question.expiresAt.getTime();
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Get a question by ID or throw a descriptive error.
   */
  private getQuestionOrThrow(questionId: string): Question {
    const question = this.questions.get(questionId);
    if (!question) {
      throw new Error(`Question "${questionId}" not found`);
    }
    return question;
  }
}
