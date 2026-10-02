/**
 * Recovery Manager - 5-Stage Recovery Escalation
 *
 * Provides automatic recovery when LLM calls fail, escalating through:
 * 1. Fallback model
 * 2. Strip thinking blocks
 * 3. Soft reset (trim conversation)
 * 4. Lightweight model
 * 5. Fatal (give up)
 */

import { ErrorClassifier, ErrorCategory, type ClassifiedError } from "./error-classifier";

export interface RecoveryConfig {
  fallbackModel?: string;
  lightweightModel?: string;
  maxConsecutiveFailures?: number; // default: 7
  softResetMessageCount?: number;  // default: 20
}

export interface RecoveryState {
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastFailureTime: Date | null;
  currentModel: string | null;
  fallbackUsed: boolean;
  thinkingStripped: boolean;
  softResetDone: boolean;
}

export interface RecoveryAction {
  stage: number;
  action: 'fallback_model' | 'strip_thinking' | 'soft_reset' | 'lightweight_model' | 'fatal';
  description: string;
  modelOverride?: string;
}

export class RecoveryManager {
  private state: RecoveryState;
  private config: Required<RecoveryConfig>;
  private history: Array<{ time: Date; reason: string; action: RecoveryAction }> = [];
  private errorClassifier: ErrorClassifier;

  constructor(config?: RecoveryConfig) {
    this.config = {
      fallbackModel: config?.fallbackModel ?? '',
      lightweightModel: config?.lightweightModel ?? '',
      maxConsecutiveFailures: config?.maxConsecutiveFailures ?? 7,
      softResetMessageCount: config?.softResetMessageCount ?? 20,
    };
    this.state = {
      consecutiveFailures: 0,
      lastFailureReason: null,
      lastFailureTime: null,
      currentModel: null,
      fallbackUsed: false,
      thinkingStripped: false,
      softResetDone: false,
    };
    this.errorClassifier = new ErrorClassifier();
  }

  /** Record a failure and return the recovery action to take */
  recordFailure(reason: string, classified?: ClassifiedError): RecoveryAction {
    // Auto-classify if not provided
    const error = classified ?? this.errorClassifier.classify(new Error(reason));

    // Fatal errors escalate immediately regardless of count
    if (error.severity === 'fatal') {
      this.state.consecutiveFailures++;
      this.state.lastFailureReason = reason;
      this.state.lastFailureTime = new Date();
      const action: RecoveryAction = {
        stage: 5,
        action: 'fatal',
        description: `Fatal error (${error.category}): ${reason}. Recovery hint: ${error.recoveryHint}`,
      };
      this.history.push({ time: new Date(), reason, action });
      return action;
    }

    // Context overflow → trigger strip_thinking as immediate recovery
    if (error.category === ErrorCategory.CONTEXT_OVERFLOW) {
      this.state.consecutiveFailures++;
      this.state.lastFailureReason = reason;
      this.state.lastFailureTime = new Date();
      this.state.thinkingStripped = true;
      const action: RecoveryAction = {
        stage: 2,
        action: 'strip_thinking',
        description: `Context overflow detected: ${reason}. Trimming conversation context.`,
      };
      this.history.push({ time: new Date(), reason, action });
      return action;
    }

    // Rate limits → switch to fallback model immediately instead of waiting
    if (error.category === ErrorCategory.RATE_LIMIT && this.config.fallbackModel && !this.state.fallbackUsed) {
      this.state.consecutiveFailures++;
      this.state.lastFailureReason = reason;
      this.state.lastFailureTime = new Date();
      this.state.fallbackUsed = true;
      this.state.currentModel = this.config.fallbackModel;
      const waitSec = Math.ceil(error.suggestedWaitMs / 1000);
      const action: RecoveryAction = {
        stage: 1,
        action: 'fallback_model',
        description: `Rate limited (back off ${waitSec}s): switching to fallback model ${this.config.fallbackModel}`,
        modelOverride: this.config.fallbackModel,
      };
      this.history.push({ time: new Date(), reason, action });
      return action;
    }

    // Count-based escalation (unchanged logic)
    this.state.consecutiveFailures++;
    this.state.lastFailureReason = reason;
    this.state.lastFailureTime = new Date();

    const count = this.state.consecutiveFailures;
    let action: RecoveryAction;

    if (count >= this.config.maxConsecutiveFailures) {
      action = { stage: 5, action: 'fatal', description: `Max failures (${this.config.maxConsecutiveFailures}) reached. Last error: ${reason}` };
    } else if (count >= 5 && this.config.lightweightModel) {
      action = { stage: 4, action: 'lightweight_model', description: `Switching to lightweight model after ${count} failures`, modelOverride: this.config.lightweightModel };
      this.state.currentModel = this.config.lightweightModel;
    } else if (count >= 3 && !this.state.softResetDone) {
      action = { stage: 3, action: 'soft_reset', description: `Soft reset: trimming to last ${this.config.softResetMessageCount} messages` };
      this.state.softResetDone = true;
    } else if (count >= 2 && !this.state.thinkingStripped) {
      action = { stage: 2, action: 'strip_thinking', description: 'Stripping thinking blocks from conversation' };
      this.state.thinkingStripped = true;
    } else if (count >= 1 && this.config.fallbackModel && !this.state.fallbackUsed) {
      action = { stage: 1, action: 'fallback_model', description: `Switching to fallback model: ${this.config.fallbackModel}`, modelOverride: this.config.fallbackModel };
      this.state.fallbackUsed = true;
      this.state.currentModel = this.config.fallbackModel;
    } else {
      // No more recovery options, escalate to fatal
      action = { stage: 5, action: 'fatal', description: `No recovery options left. Error: ${reason}` };
    }

    this.history.push({ time: new Date(), reason, action });
    return action;
  }

  /** Record success and reset failure count */
  recordSuccess(): void {
    this.state.consecutiveFailures = 0;
    this.state.lastFailureReason = null;
    this.state.lastFailureTime = null;
    // Don't reset model/fallback flags — they persist for the session
  }

  /** Full reset of recovery state */
  reset(): void {
    this.state = {
      consecutiveFailures: 0,
      lastFailureReason: null,
      lastFailureTime: null,
      currentModel: null,
      fallbackUsed: false,
      thinkingStripped: false,
      softResetDone: false,
    };
  }

  getState(): RecoveryState { return { ...this.state }; }
  getHistory(): Array<{ time: Date; reason: string; action: RecoveryAction }> { return [...this.history]; }
  getFailureCount(): number { return this.state.consecutiveFailures; }
  isFatal(): boolean { return this.state.consecutiveFailures >= this.config.maxConsecutiveFailures; }
}
