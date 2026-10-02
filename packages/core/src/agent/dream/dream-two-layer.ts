/**
 * Dream Cycle — Two-Layer Knowledge
 *
 * Manages raw daily notes and compiled wiki with claims/evidence.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A raw note captured during the day (layer 1 — unprocessed). */
export interface RawDailyNote {
  id: string;
  content: string;
  source: string;
  timestamp: number;
  tags: string[];
  /** Set when this note has been compiled into the wiki layer. */
  compiledAt?: number;
}

/** A claim extracted from raw notes, with supporting evidence (layer 2). */
export interface CompiledClaim {
  id: string;
  claim: string;
  evidenceNoteIds: string[];
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface TwoLayerKnowledge {
  /** Layer 1 — raw, unprocessed daily notes. */
  rawNotes: RawDailyNote[];
  /** Layer 2 — compiled claims with evidence links. */
  claims: CompiledClaim[];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TwoLayerKnowledgeStore {
  private knowledge: TwoLayerKnowledge;

  constructor(initial?: Partial<TwoLayerKnowledge>) {
    this.knowledge = {
      rawNotes: initial?.rawNotes ?? [],
      claims: initial?.claims ?? [],
    };
  }

  /**
   * Add a raw daily note (layer 1).
   */
  addRawNote(
    content: string,
    source: string,
    tags: string[] = [],
  ): RawDailyNote {
    const note: RawDailyNote = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      content,
      source,
      timestamp: Date.now(),
      tags,
    };
    this.knowledge.rawNotes.push(note);
    return note;
  }

  /**
   * Compile unprocessed raw notes into a claim (promotes to layer 2).
   */
  compileClaim(claim: string, evidenceNoteIds: string[], confidence: number): CompiledClaim {
    const now = Date.now();
    const compiled: CompiledClaim = {
      id: `claim-${now}-${Math.random().toString(36).slice(2, 8)}`,
      claim,
      evidenceNoteIds,
      confidence,
      createdAt: now,
      updatedAt: now,
    };
    this.knowledge.claims.push(compiled);

    for (const note of this.knowledge.rawNotes) {
      if (evidenceNoteIds.includes(note.id)) {
        note.compiledAt = now;
      }
    }

    return compiled;
  }

  /**
   * Get all raw notes that have not yet been compiled.
   */
  getUncompiledNotes(): RawDailyNote[] {
    return this.knowledge.rawNotes.filter((note) => note.compiledAt === undefined);
  }

  /**
   * Get all compiled claims.
   */
  getClaims(): CompiledClaim[] {
    return [...this.knowledge.claims];
  }

  /**
   * Full snapshot of both layers.
   */
  snapshot(): TwoLayerKnowledge {
    return {
      rawNotes: [...this.knowledge.rawNotes],
      claims: [...this.knowledge.claims],
    };
  }
}
