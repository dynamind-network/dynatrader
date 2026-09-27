/**
 * Reflection Runner
 *
 * Lightweight end-of-turn memory extraction. Fire-and-forget after each reply.
 * Sliding-window segmentation: fire every N turns over last W message pairs.
 *
 * Extracts typed notes from the agent's own reasoning:
 * - [event]: significant occurrences (tool failures, user corrections)
 * - [behavior]: patterns the agent noticed in itself
 * - [knowledge]: new facts or relationships discovered
 * - [skill]: technique that worked well (feeds skill evolution)
 *
 * Runs on a dedicated slot so it never delays the user's response.
 */

import { createHash } from "node:crypto";

export type NoteType = "event" | "behavior" | "knowledge" | "skill";

export interface ReflectionConfig {
  /** How many message pairs (user+assistant) before firing reflection. Default: 5 */
  windowSize?: number;
  /** Minimum turns before first reflection. Default: 3 */
  minTurnsBeforeReflection?: number;
  /** Max notes to extract per reflection. Default: 5 */
  maxNotesPerReflection?: number;
  /** Deduplicate notes by content hash within this many recent notes. Default: 50 */
  deduplicationWindow?: number;
}

export interface ExtractedNote {
  type: NoteType;
  content: string;
  confidence: number;
  sourceTurn: number;
  context?: string;
  tags?: string[];
}

export interface ReflectionResult {
  notes: ExtractedNote[];
  turnNumber: number;
  windowRange: [number, number];
  firedAt: number;
}

export interface MessagePair {
  userMessage: string;
  assistantResponse: string;
  turnNumber: number;
}

/**
 * Stores recent messages and fires reflection at sliding window boundaries.
 */
export class ReflectionRunner {
  private readonly windowSize: number;
  private readonly minTurnsBeforeReflection: number;
  private readonly maxNotesPerReflection: number;
  private readonly deduplicationWindow: number;

  private recentMessages: MessagePair[] = [];
  private recentNoteHashes: string[] = [];
  private turnCount = 0;
  private lastReflectionTurn = 0;

  constructor(config?: ReflectionConfig) {
    this.windowSize = config?.windowSize ?? 5;
    this.minTurnsBeforeReflection = config?.minTurnsBeforeReflection ?? 3;
    this.maxNotesPerReflection = config?.maxNotesPerReflection ?? 5;
    this.deduplicationWindow = config?.deduplicationWindow ?? 50;
  }

  /**
   * Record a message pair. Returns reflection result if it's time to fire.
   * Returns null if not yet time.
   */
  addPair(userMessage: string, assistantResponse: string): ReflectionResult | null {
    this.turnCount++;
    this.recentMessages.push({
      userMessage,
      assistantResponse,
      turnNumber: this.turnCount,
    });

    // Keep bounded
    if (this.recentMessages.length > this.windowSize * 2) {
      this.recentMessages = this.recentMessages.slice(-this.windowSize * 2);
    }

    // Check if it's time to reflect
    if (this.turnCount < this.minTurnsBeforeReflection) return null;
    if (this.turnCount - this.lastReflectionTurn < this.windowSize) return null;

    return this.extractReflection();
  }

  /**
   * Force a reflection (e.g., at session end).
   */
  forceReflection(): ReflectionResult | null {
    if (this.recentMessages.length === 0) return null;
    return this.extractReflection();
  }

  /**
   * Get current turn count.
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Reset state.
   */
  reset(): void {
    this.recentMessages = [];
    this.recentNoteHashes = [];
    this.turnCount = 0;
    this.lastReflectionTurn = 0;
  }

  private extractReflection(): ReflectionResult {
    const windowStart = Math.max(0, this.recentMessages.length - this.windowSize);
    const windowEnd = this.recentMessages.length;
    const windowRange: [number, number] = [
      this.recentMessages[windowStart]?.turnNumber ?? 1,
      this.recentMessages[windowEnd - 1]?.turnNumber ?? this.turnCount,
    ];

    const notes: ExtractedNote[] = [];

    for (const pair of this.recentMessages.slice(windowStart, windowEnd)) {
      const extracted = this.extractFromPair(pair);
      for (const note of extracted) {
        if (notes.length >= this.maxNotesPerReflection) break;
        if (!this.isDuplicate(note)) {
          notes.push(note);
          this.recentNoteHashes.push(this.hashNote(note));
        }
      }
    }

    // Trim dedup window
    if (this.recentNoteHashes.length > this.deduplicationWindow) {
      this.recentNoteHashes = this.recentNoteHashes.slice(-this.deduplicationWindow);
    }

    this.lastReflectionTurn = this.turnCount;

    return {
      notes,
      turnNumber: this.turnCount,
      windowRange,
      firedAt: Date.now(),
    };
  }

  private extractFromPair(pair: MessagePair): ExtractedNote[] {
    const notes: ExtractedNote[] = [];
    const userLower = pair.userMessage.toLowerCase();
    const assistantLower = pair.assistantResponse.toLowerCase();

    // Detect event: tool failures, errors, corrections
    if (
      assistantLower.includes("error") ||
      assistantLower.includes("failed") ||
      assistantLower.includes("unable to") ||
      assistantLower.includes("couldn't")
    ) {
      notes.push({
        type: "event",
        content: `Tool or action failed during turn ${pair.turnNumber}. Agent reported: ${pair.assistantResponse.slice(0, 150)}`,
        confidence: 0.8,
        sourceTurn: pair.turnNumber,
        tags: ["failure", "error"],
      });
    }

    // Detect user correction
    if (
      userLower.includes("no, ") ||
      userLower.includes("wrong") ||
      userLower.includes("actually") ||
      userLower.includes("don't do that") ||
      userLower.includes("stop")
    ) {
      notes.push({
        type: "behavior",
        content: `User corrected agent at turn ${pair.turnNumber}. User said: "${pair.userMessage.slice(0, 150)}"`,
        confidence: 0.9,
        sourceTurn: pair.turnNumber,
        tags: ["correction", "user-feedback"],
      });
    }

    // Detect knowledge: new information discovered
    if (
      assistantLower.includes("i found") ||
      assistantLower.includes("discovered") ||
      assistantLower.includes("learned that") ||
      assistantLower.includes("it turns out") ||
      assistantLower.includes("based on the data")
    ) {
      notes.push({
        type: "knowledge",
        content: `New knowledge from turn ${pair.turnNumber}: ${pair.assistantResponse.slice(0, 200)}`,
        confidence: 0.7,
        sourceTurn: pair.turnNumber,
        tags: ["discovery"],
      });
    }

    // Detect skill: technique that worked well
    if (
      assistantLower.includes("successfully") ||
      assistantLower.includes("worked well") ||
      assistantLower.includes("efficient") ||
      assistantLower.includes("optimized")
    ) {
      notes.push({
        type: "skill",
        content: `Effective technique at turn ${pair.turnNumber}: ${pair.assistantResponse.slice(0, 200)}`,
        confidence: 0.6,
        sourceTurn: pair.turnNumber,
        tags: ["effective-technique"],
      });
    }

    // Detect proactive behavior
    if (
      assistantLower.includes("i went ahead") ||
      assistantLower.includes("i proactively") ||
      assistantLower.includes("without being asked")
    ) {
      notes.push({
        type: "behavior",
        content: `Proactive behavior at turn ${pair.turnNumber}: ${pair.assistantResponse.slice(0, 200)}`,
        confidence: 0.7,
        sourceTurn: pair.turnNumber,
        tags: ["proactive"],
      });
    }

    return notes;
  }

  private isDuplicate(note: ExtractedNote): boolean {
    const hash = this.hashNote(note);
    return this.recentNoteHashes.includes(hash);
  }

  private hashNote(note: ExtractedNote): string {
    return createHash("sha256")
      .update(`${note.type}:${note.content.slice(0, 100)}`)
      .digest("hex")
      .slice(0, 16);
  }
}
