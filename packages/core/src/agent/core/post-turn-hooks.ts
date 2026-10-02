/**
 * Post-Turn Hooks
 *
 * After each turn, decides whether anything is worth persisting.
 * Most turns have nothing worth syncing — skipping them keeps the loop fast.
 *
 * Decision gates:
 * 1. Correction detected → sync correction to memory
 * 2. Preference detected → sync preference to memory
 * 3. Skill match detected → sync skill usage
 * 4. Meaningful tool call (write/edit/execute) → record creation
 * 5. Every N turns → background review (skill evolution check)
 *
 * If none of these fire, the hooks are near-zero cost.
 */

import type { MemoryStoreImpl } from "@dyna/memory-core";

export interface PostTurnHookDeps {
  memory: MemoryStoreImpl;
  sessionId: string;
  userMessage: string;
  assistantResponse: string;
  turnCount: number;
  toolCalls?: Array<{ tool: string; args: unknown; result?: unknown }>;
  onMemorySync?: (result: MemorySyncResult) => void;
  onBackgroundReview?: (result: BackgroundReviewResult) => void;
}

export interface MemorySyncResult {
  entriesWritten: number;
  durationMs: number;
  skipped: boolean;
}

export interface BackgroundReviewResult {
  skillsReviewed: number;
  skillsUpdated: number;
  memoriesSaved: number;
  durationMs: number;
}

const CORRECTION_PATTERNS = [
  /don't use/i,
  /stop doing/i,
  /that's wrong/i,
  /actually,?/i,
  /prefer/i,
  /instead of/i,
  /never do/i,
  /always do/i,
];

const PREFERENCE_PATTERNS = [
  /i prefer/i,
  /i like/i,
  /i want/i,
  /please use/i,
  /my preference/i,
  /i always/i,
  /i never/i,
];

const SKILL_PATTERN = /\[Skill\]\s*(.+)/g;

const MEANINGFUL_TOOLS = new Set([
  "write", "edit", "exec", "skill_manage", "delegate_task",
]);

/**
 * Run post-turn hooks. Returns early if nothing is worth syncing.
 */
export async function runPostTurnHooks(
  deps: PostTurnHookDeps,
): Promise<void> {
  const startTime = Date.now();

  const isCorrection = CORRECTION_PATTERNS.some((p) => p.test(deps.userMessage));
  const isPreference = PREFERENCE_PATTERNS.some((p) => p.test(deps.userMessage));
  const skillMatches = [...deps.assistantResponse.matchAll(SKILL_PATTERN)];
  const hasMeaningfulTool = deps.toolCalls?.some((tc) => MEANINGFUL_TOOLS.has(tc.tool)) ?? false;
  const isReviewTurn = deps.turnCount > 0 && deps.turnCount % 5 === 0;

  const hasWork = isCorrection || isPreference || skillMatches.length > 0 || hasMeaningfulTool || isReviewTurn;

  if (!hasWork) {
    // Nothing worth syncing — skip entirely
    return;
  }

  // Something meaningful happened — sync memory
  try {
    const syncResult = await syncMemory(deps, { isCorrection, isPreference });
    deps.onMemorySync?.(syncResult);
  } catch (err) {
    console.warn("Memory sync failed:", err);
  }

  // Background review — only on review turns
  if (isReviewTurn) {
    try {
      const reviewResult = await backgroundReview(deps, skillMatches);
      deps.onBackgroundReview?.(reviewResult);
    } catch (err) {
      console.warn("Background review failed:", err);
    }
  }
}

async function syncMemory(
  deps: PostTurnHookDeps,
  signals: { isCorrection: boolean; isPreference: boolean },
): Promise<MemorySyncResult> {
  const startTime = Date.now();
  let entriesWritten = 0;
  const { memory, userMessage, assistantResponse, sessionId } = deps;

  if (signals.isCorrection) {
    await memory.put({
      scope: "agent_memory",
      kind: "correction",
      payload: {
        type: "correction",
        userMessage: userMessage.slice(0, 500),
        assistantResponse: assistantResponse.slice(0, 500),
        sessionId,
        timestamp: new Date().toISOString(),
      },
      ts: new Date(),
    });
    entriesWritten++;
  }

  if (signals.isPreference) {
    await memory.put({
      scope: "user_profile",
      kind: "preference",
      payload: {
        type: "preference",
        content: userMessage.slice(0, 500),
        sessionId,
        timestamp: new Date().toISOString(),
      },
      ts: new Date(),
    });
    entriesWritten++;
  }

  return {
    entriesWritten,
    durationMs: Date.now() - startTime,
    skipped: entriesWritten === 0,
  };
}

async function backgroundReview(
  deps: PostTurnHookDeps,
  skillMatches: RegExpMatchArray[],
): Promise<BackgroundReviewResult> {
  const startTime = Date.now();
  const { memory, assistantResponse, sessionId } = deps;

  let skillsReviewed = 0;
  let memoriesSaved = 0;

  for (const match of skillMatches) {
    skillsReviewed++;
    await memory.put({
      scope: "skill_usage",
      kind: "skill_used",
      payload: {
        type: "skill_used",
        skillName: match[1],
        sessionId,
        userMessage: deps.userMessage.slice(0, 200),
        timestamp: new Date().toISOString(),
      },
      ts: new Date(),
    });
    memoriesSaved++;
  }

  const creationPatterns = [
    /created?\s+(?:a\s+)?(?:new\s+)?/i,
    /wrote?\s+(?:a\s+)?/i,
    /added?\s+(?:a\s+)?/i,
    /implemented?\s+/i,
  ];

  if (creationPatterns.some((p) => p.test(assistantResponse))) {
    await memory.put({
      scope: "agent_memory",
      kind: "creation",
      payload: {
        type: "creation",
        summary: assistantResponse.slice(0, 500),
        sessionId,
        timestamp: new Date().toISOString(),
      },
      ts: new Date(),
    });
    memoriesSaved++;
  }

  return {
    skillsReviewed,
    skillsUpdated: 0,
    memoriesSaved,
    durationMs: Date.now() - startTime,
  };
}
