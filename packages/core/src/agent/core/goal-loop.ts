/**
 * GoalLoopManager — self-continuing goal loop
 *
 * A per-session goal the agent works toward across multiple turns. After each
 * turn, evaluateAfterTurn() decides whether to continue (feeding a continuation
 * prompt back as the next user turn) or stop (checklist met / max turns /
 * paused / cleared).
 *
 * Judge: deterministic. While a goal is active the continuation prompt
 * instructs the model to append a `GOAL_STATUS: {complete: true|false}` line;
 * the manager parses it. No aux LLM call.
 */

export interface GoalState {
  goal: string;
  status: "active" | "paused" | "done" | "cleared";
  turnsUsed: number;
  maxTurns: number;
  checklist: string[];
  completedItems: string[];
  createdAt: number;
  lastTurnAt: number;
}

export interface ContinuationDecision {
  status: GoalState["status"] | "none";
  shouldContinue: boolean;
  continuationPrompt: string | null;
  message: string;
}

export const DEFAULT_MAX_TURNS = 25;

const CONTINUATION_TEMPLATE = `You are working toward a standing goal. Keep working on it now.

GOAL: {goal}

Remaining criteria:
{criteria}

When ALL criteria are satisfied, end your response with exactly:
GOAL_STATUS: {{complete: true}}

Otherwise keep making progress and end with:
GOAL_STATUS: {{complete: false}}`;

function parseGoalStatus(response: string): boolean | null {
  const match = response.match(/GOAL_STATUS:\s*\{[^}]*complete\s*:\s*(true|false)/i);
  return match ? match[1]!.toLowerCase() === "true" : null;
}

/** Detect which checklist items the response marks complete ("item: done"). */
function detectCompleted(checklist: string[], response: string): string[] {
  return checklist.filter((item) => {
    if (this_done(item)) return true;
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s*[:—-]?\\s*(done|complete[d]?|✓)`, "i");
    return re.test(response);
  });

  function this_done(item: string): boolean {
    return false;
  }
}

export class GoalLoopManager {
  private state: GoalState | null = null;

  set(goal: string, checklist: string[] = [], maxTurns = DEFAULT_MAX_TURNS): GoalState {
    goal = goal.trim();
    if (!goal) throw new Error("goal text is empty");
    this.state = {
      goal,
      status: "active",
      turnsUsed: 0,
      maxTurns,
      checklist,
      completedItems: [],
      createdAt: Date.now(),
      lastTurnAt: 0,
    };
    return this.state;
  }

  isActive(): boolean {
    return this.state !== null && this.state.status === "active";
  }

  getStatus(): GoalState | null {
    return this.state;
  }

  addChecklistItem(item: string): void {
    if (!this.state) throw new Error("No active goal");
    this.state.checklist.push(item.trim());
  }

  pause(reason = "user-paused"): GoalState | null {
    if (!this.state || this.state.status !== "active") return null;
    this.state.status = "paused";
    void reason;
    return this.state;
  }

  resume(): GoalState | null {
    if (!this.state || this.state.status !== "paused") return null;
    this.state.status = "active";
    return this.state;
  }

  clear(): boolean {
    const had = this.state !== null && this.state.status !== "cleared";
    if (this.state) this.state.status = "cleared";
    return had;
  }

  /** Mark done explicitly (user says /goal done). */
  markDone(): void {
    if (this.state) this.state.status = "done";
  }

  /**
   * Called after every agent turn while a goal is active.
   * Returns whether to feed the continuation prompt back for another turn.
   */
  evaluateAfterTurn(lastResponse: string): ContinuationDecision {
    if (!this.state || this.state.status !== "active") {
      return { status: "none", shouldContinue: false, continuationPrompt: null, message: "No active goal." };
    }

    this.state.turnsUsed += 1;
    this.state.lastTurnAt = Date.now();

    // Record newly-completed checklist items from the response text.
    for (const item of detectCompleted(this.state.checklist, lastResponse)) {
      if (!this.state.completedItems.includes(item)) this.state.completedItems.push(item);
    }

    // Explicit model signal wins.
    const reported = parseGoalStatus(lastResponse);

    const allDone =
      this.state.checklist.length > 0 &&
      this.state.completedItems.length >= this.state.checklist.length;

    if (reported === true || allDone || (reported === null && this.state.checklist.length === 0 && /goal.*(complete|achieved|done)/i.test(lastResponse))) {
      this.state.status = "done";
      return {
        status: "done",
        shouldContinue: false,
        continuationPrompt: null,
        message: `Goal complete (${this.state.turnsUsed} turns): ${this.state.goal}`,
      };
    }

    if (this.state.turnsUsed >= this.state.maxTurns) {
      this.state.status = "paused";
      return {
        status: "paused",
        shouldContinue: false,
        continuationPrompt: null,
        message: `Goal paused at max turns (${this.state.maxTurns}): ${this.state.goal}. Use /goal resume or /goal clear.`,
      };
    }

    const remaining = this.state.checklist.filter((c) => !this.state!.completedItems.includes(c));
    const criteriaBlock = remaining.length > 0 ? remaining.map((c) => `- [ ] ${c}`).join("\n") : "- (work toward the goal; mark items done as you finish them)";

    const prompt = CONTINUATION_TEMPLATE.replace("{goal}", this.state.goal).replace("{criteria}", criteriaBlock);

    return {
      status: "active",
      shouldContinue: true,
      continuationPrompt: prompt,
      message: `Continuing toward goal (${this.state.turnsUsed}/${this.state.maxTurns})`,
    };
  }
}
