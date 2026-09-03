/**
 * Continual Harness /refine — Self-Improvement Engine
 *
 * Reviews agent trajectories, persists reviewable lessons as supplemental
 * prompts. The agent becomes better the more it works with the user.
 *
 * Atomic Agent pattern: review past trajectories, extract lessons,
 * store as supplemental prompts for future sessions.
 */

import { randomUUID } from "node:crypto";

export interface TrajectoryStep {
  turnNumber: number;
  userMessage: string;
  assistantResponse: string;
  toolCalls?: Array<{
    tool: string;
    args: Record<string, unknown>;
    success: boolean;
    durationMs: number;
  }>;
  durationMs: number;
}

export interface TrajectoryReview {
  id: string;
  trajectoryId: string;
  sessionId: string;
  overallAssessment: "excellent" | "good" | "acceptable" | "poor" | "failed";
  lessons: Lesson[];
  suggestedImprovements: string[];
  reviewTimestamp: number;
  reviewerNotes?: string;
}

export interface Lesson {
  type: "strategy" | "tool-usage" | "communication" | "error-recovery" | "efficiency";
  content: string;
  confidence: number;
  tags: string[];
}

export interface ContinualHarnessConfig {
  /** Max lessons to store per trajectory. Default: 10 */
  maxLessonsPerTrajectory?: number;
  /** Min confidence to persist a lesson. Default: 0.5 */
  minLessonConfidence?: number;
  /** Max supplemental prompts to load. Default: 20 */
  maxSupplementalPrompts?: number;
  /** Lesson TTL (ms). Default: 30 days */
  lessonTtlMs?: number;
}

/**
 * Stores and retrieves lessons from agent trajectory reviews.
 */
export class ContinualHarness {
  private readonly maxLessonsPerTrajectory: number;
  private readonly minLessonConfidence: number;
  private readonly maxSupplementalPrompts: number;
  private readonly lessonTtlMs: number;

  private lessons = new Map<string, Lesson & { id: string; trajectoryId: string; sessionId: string; createdAt: number }>();
  private reviews = new Map<string, TrajectoryReview>();

  constructor(config?: ContinualHarnessConfig) {
    this.maxLessonsPerTrajectory = config?.maxLessonsPerTrajectory ?? 10;
    this.minLessonConfidence = config?.minLessonConfidence ?? 0.5;
    this.maxSupplementalPrompts = config?.maxSupplementalPrompts ?? 20;
    this.lessonTtlMs = config?.lessonTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  /**
   * Review a completed trajectory and extract lessons.
   */
  reviewTrajectory(
    trajectoryId: string,
    sessionId: string,
    steps: TrajectoryStep[],
    overallAssessment: TrajectoryReview["overallAssessment"],
    reviewerNotes?: string,
  ): TrajectoryReview {
    const lessons = this.extractLessons(steps);
    const suggestedImprovements = this.suggestImprovements(steps, overallAssessment);

    const review: TrajectoryReview = {
      id: randomUUID(),
      trajectoryId,
      sessionId,
      overallAssessment,
      lessons: lessons.slice(0, this.maxLessonsPerTrajectory),
      suggestedImprovements,
      reviewTimestamp: Date.now(),
      reviewerNotes,
    };

    this.reviews.set(review.id, review);

    // Persist high-confidence lessons
    for (const lesson of review.lessons) {
      if (lesson.confidence >= this.minLessonConfidence) {
        const record = {
          ...lesson,
          id: randomUUID(),
          trajectoryId,
          sessionId,
          createdAt: Date.now(),
        };
        this.lessons.set(record.id, record);
      }
    }

    this.evictOldLessons();
    return review;
  }

  /**
   * Get supplemental prompts for a new session.
   * Returns lessons relevant to the current context.
   */
  getSupplementalPrompts(context?: {
    sessionId?: string;
    topic?: string;
    recentTools?: string[];
  }): string[] {
    let lessons = Array.from(this.lessons.values());

    // Filter by TTL
    const now = Date.now();
    lessons = lessons.filter((l) => now - l.createdAt < this.lessonTtlMs);

    // Sort by confidence (highest first)
    lessons.sort((a, b) => b.confidence - a.confidence);

    // Take top N
    const top = lessons.slice(0, this.maxSupplementalPrompts);

    return top.map((l) => `[Lesson: ${l.type}] ${l.content}`);
  }

  /**
   * Get all reviews for a session.
   */
  getReviews(sessionId: string): TrajectoryReview[] {
    return Array.from(this.reviews.values())
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => b.reviewTimestamp - a.reviewTimestamp);
  }

  /**
   * Get all lessons.
   */
  getAllLessons(): Array<Lesson & { id: string; trajectoryId: string; sessionId: string; createdAt: number }> {
    return Array.from(this.lessons.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Export for persistence.
   */
  exportToStore(): {
    lessons: Array<Lesson & { id: string; trajectoryId: string; sessionId: string; createdAt: number }>;
    reviews: TrajectoryReview[];
  } {
    return {
      lessons: Array.from(this.lessons.values()),
      reviews: Array.from(this.reviews.values()),
    };
  }

  /**
   * Load from persistent store.
   */
  loadFromStore(data: {
    lessons?: Array<Lesson & { id: string; trajectoryId: string; sessionId: string; createdAt: number }>;
    reviews?: TrajectoryReview[];
  }): void {
    if (data.lessons) {
      for (const lesson of data.lessons) {
        this.lessons.set(lesson.id, lesson);
      }
    }
    if (data.reviews) {
      for (const review of data.reviews) {
        this.reviews.set(review.id, review);
      }
    }
  }

  private extractLessons(steps: TrajectoryStep[]): Lesson[] {
    const lessons: Lesson[] = [];

    // Analyze tool usage patterns
    const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
    const toolFailures = toolCalls.filter((tc) => !tc.success);
    const toolSuccesses = toolCalls.filter((tc) => tc.success);

    if (toolFailures.length > 0) {
      const failedTools = [...new Set(toolFailures.map((tc) => tc.tool))];
      lessons.push({
        type: "error-recovery",
        content: `Tools that failed: ${failedTools.join(", ")}. Consider alternative approaches for these operations.`,
        confidence: 0.7,
        tags: ["tool-failure", ...failedTools],
      });
    }

    if (toolSuccesses.length > 0) {
      const successfulTools = [...new Set(toolSuccesses.map((tc) => tc.tool))];
      lessons.push({
        type: "tool-usage",
        content: `Effective tools used: ${successfulTools.join(", ")}.`,
        confidence: 0.5,
        tags: ["tool-success", ...successfulTools],
      });
    }

    // Analyze conversation quality
    const avgResponseLength = steps.reduce((sum, s) => sum + s.assistantResponse.length, 0) / steps.length;
    if (avgResponseLength > 2000) {
      lessons.push({
        type: "communication",
        content: "Responses were lengthy. Consider being more concise for better user experience.",
        confidence: 0.6,
        tags: ["verbosity"],
      });
    }

    // Analyze efficiency
    const totalDuration = steps.reduce((sum, s) => sum + s.durationMs, 0);
    const avgDuration = totalDuration / steps.length;
    if (avgDuration > 10000) {
      lessons.push({
        type: "efficiency",
        content: "Turns were slow. Consider optimizing tool calls or reducing unnecessary steps.",
        confidence: 0.6,
        tags: ["slow-turns"],
      });
    }

    return lessons;
  }

  private suggestImprovements(
    steps: TrajectoryStep[],
    assessment: TrajectoryReview["overallAssessment"],
  ): string[] {
    const improvements: string[] = [];

    if (assessment === "poor" || assessment === "failed") {
      improvements.push("Review the trajectory to identify where things went wrong.");
    }

    const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
    if (toolCalls.length === 0) {
      improvements.push("No tools were used. Consider if tools could have helped.");
    }

    const failedTools = toolCalls.filter((tc) => !tc.success);
    if (failedTools.length > toolCalls.length * 0.5) {
      improvements.push("High tool failure rate. Check tool configuration or try different approaches.");
    }

    return improvements;
  }

  private evictOldLessons(): void {
    const now = Date.now();
    for (const [id, lesson] of this.lessons) {
      if (now - lesson.createdAt > this.lessonTtlMs) {
        this.lessons.delete(id);
      }
    }
  }
}
