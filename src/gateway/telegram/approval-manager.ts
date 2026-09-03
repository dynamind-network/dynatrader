/**
 * Telegram Approval Manager
 *
 * Gates dangerous operations behind user approval via inline keyboard buttons.
 * Supports tiered approval: Allow Once / Allow Session / Always Allow / Deny.
 * Auto-expires pending approvals after a configurable timeout.
 *
 * Usage:
 *   const manager = new ApprovalManager(gateway, [userId1, userId2]);
 *   const choice = await manager.requestApproval(chatId, "rm -rf /tmp/build", "high");
 *   if (choice === "deny") throw new Error("User denied operation");
 */

import type { TelegramGateway } from "./telegram-gateway";
import { Logger } from "../../audit/logger";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface PendingApproval {
  id: string;
  operation: string;
  command?: string;
  riskLevel: RiskLevel;
  timestamp: Date;
  chatId: number;
  messageId?: number;
  resolve: (choice: ApprovalChoice) => void;
}

export interface DangerousPattern {
  pattern: RegExp;
  severity: RiskLevel;
  message: string;
}

// ---------------------------------------------------------------------------
// Dangerous patterns
// ---------------------------------------------------------------------------

export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // Trading operations
  { pattern: /close\s+position|liquidate|sell\s+all/i, severity: "high", message: "Position close/liquidation detected" },
  { pattern: /order.*size.*>.*1000|order.*value.*>.*1000/i, severity: "high", message: "Large order detected" },
  { pattern: /place.*order|execute.*trade|buy.*sell/i, severity: "medium", message: "Trade execution detected" },

  // System operations
  { pattern: /rm\s+-rf|sudo\s+rm|delete.*all/i, severity: "critical", message: "Destructive file operation" },
  { pattern: /git\s+reset\s+--hard|git\s+push\s+--force/i, severity: "high", message: "Force git operation" },
  { pattern: /docker\s+(stop|rm|kill)/i, severity: "medium", message: "Docker container operation" },
  { pattern: /DROP\s+TABLE|DROP\s+DATABASE|DELETE\s+FROM/i, severity: "critical", message: "Database destructive operation" },

  // Config changes
  { pattern: /modify.*config|change.*api.*key|rotate.*secret/i, severity: "medium", message: "Configuration change" },
  { pattern: /curl.*POST|wget.*POST/i, severity: "low", message: "HTTP POST request" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RISK_EMOJI: Record<RiskLevel, string> = {
  low: "\u{1F7E2}",     // green circle
  medium: "\u{1F7E1}",  // yellow circle
  high: "\u{1F7E0}",    // orange circle
  critical: "\u{1F534}", // red circle
};

const AUTO_EXPIRE_MS = 60_000;

// ---------------------------------------------------------------------------
// ApprovalManager
// ---------------------------------------------------------------------------

export class ApprovalManager {
  private gateway: TelegramGateway;
  private pendingApprovals = new Map<string, PendingApproval>();
  private allowedUserIds: Set<number>;
  private sessionApprovals = new Set<string>();
  private alwaysApprovePatterns = new Set<string>();
  private logger = new Logger("ApprovalManager");

  constructor(gateway: TelegramGateway, allowedUserIds: number[]) {
    this.gateway = gateway;
    this.allowedUserIds = new Set(allowedUserIds);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check if an operation requires approval without blocking.
   * Returns whether approval is needed and which pattern matched.
   */
  requiresApproval(
    command: string,
  ): { required: boolean; pattern?: DangerousPattern } {
    // Always-approve patterns take priority
    for (const pattern of this.alwaysApprovePatterns) {
      if (new RegExp(pattern, "i").test(command)) {
        return { required: false };
      }
    }

    // Session-level approvals
    for (const approved of this.sessionApprovals) {
      if (command.includes(approved)) {
        return { required: false };
      }
    }

    // Dangerous pattern check
    for (const dangerous of DANGEROUS_PATTERNS) {
      if (dangerous.pattern.test(command)) {
        return { required: true, pattern: dangerous };
      }
    }

    return { required: false };
  }

  /**
   * Request approval for a dangerous operation via Telegram inline buttons.
   * Resolves with the user's choice or "deny" on timeout.
   */
  async requestApproval(
    chatId: number,
    command: string,
    riskLevel: RiskLevel = "medium",
    context?: string,
  ): Promise<ApprovalChoice> {
    const approvalId = `approval-${Date.now()}-${randomUUID().slice(0, 8)}`;

    return new Promise<ApprovalChoice>((resolve) => {
      const pending: PendingApproval = {
        id: approvalId,
        operation: command,
        command,
        riskLevel,
        timestamp: new Date(),
        chatId,
        resolve,
      };

      this.pendingApprovals.set(approvalId, pending);

      const emoji = RISK_EMOJI[riskLevel];
      const lines = [
        `${emoji} **Approval Required**`,
        "",
        `Operation: \`${command.slice(0, 200)}\``,
        `Risk: ${riskLevel.toUpperCase()}`,
      ];

      if (context) {
        lines.push(`Context: ${context}`);
      }

      lines.push("", "Choose an option:");

      const text = lines.join("\n");

      // Inline keyboard: one row per option
      const keyboard = [
        [
          { text: "\u2705 Allow Once", callback_data: `approve:once:${approvalId}` },
          { text: "\u{1F4CB} Allow Session", callback_data: `approve:session:${approvalId}` },
        ],
        [
          { text: "\u{1F512} Always Allow", callback_data: `approve:always:${approvalId}` },
          { text: "\u274C Deny", callback_data: `approve:deny:${approvalId}` },
        ],
      ];

      // Send with inline keyboard (gateway must support this)
      this.gateway
        .sendWithInlineKeyboard(String(chatId), text, keyboard)
        .catch((err) => {
          this.logger.error("Failed to send approval message", { error: err });
          // Fallback: send plain text and rely on text response
          this.gateway.send(String(chatId), text).catch(() => {});
        });

      // Auto-expire after timeout
      setTimeout(() => {
        if (this.pendingApprovals.has(approvalId)) {
          this.pendingApprovals.delete(approvalId);
          this.gateway
            .send(String(chatId), `${RISK_EMOJI[riskLevel]} Approval **timed out** (60s) - treating as **deny**`)
            .catch(() => {});
          resolve("deny");
        }
      }, AUTO_EXPIRE_MS);
    });
  }

  /**
   * Handle a callback query from an inline button press.
   * Returns true if the callback was consumed by this manager.
   */
  handleCallbackQuery(data: string, userId: number): boolean {
    if (!this.allowedUserIds.has(userId)) {
      this.logger.warn("Callback query from unauthorized user", { userId });
      return false;
    }

    const match = data.match(/^approve:(once|session|always|deny):(.+)$/);
    if (!match) return false;

    const [, choice, approvalId] = match;
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      this.logger.warn("Callback for unknown/expired approval", { approvalId });
      return false;
    }

    // Record approval tier
    const commandKey = pending.command ?? pending.operation;
    switch (choice as ApprovalChoice) {
      case "session":
        this.sessionApprovals.add(commandKey);
        this.logger.info("Session approval granted", { command: commandKey });
        break;
      case "always":
        this.alwaysApprovePatterns.add(commandKey);
        this.logger.info("Always-approve pattern added", { command: commandKey });
        break;
    }

    this.pendingApprovals.delete(approvalId);
    pending.resolve(choice as ApprovalChoice);

    this.logger.info("Approval resolved via callback", {
      approvalId,
      choice,
      command: commandKey,
    });

    return true;
  }

  /**
   * Handle a text message as a fallback approval response.
   * Matches the most recent pending approval for the given chat.
   * Returns true if a pending approval was resolved.
   */
  handleTextResponse(text: string, chatId: number, userId: number): boolean {
    if (!this.allowedUserIds.has(userId)) return false;

    const normalized = text.toLowerCase().trim();
    const choice: ApprovalChoice | null =
      normalized.includes("allow once") || normalized === "yes" || normalized === "y"
        ? "once"
        : normalized.includes("allow session")
          ? "session"
          : normalized.includes("always")
            ? "always"
            : normalized.includes("deny") || normalized === "no" || normalized === "n"
              ? "deny"
              : null;

    if (!choice) return false;

    // Find the most recent pending approval for this chat
    let found = false;
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.chatId === chatId) {
        this.pendingApprovals.delete(id);
        pending.resolve(choice);
        found = true;
        this.logger.info("Approval resolved via text", {
          approvalId: id,
          choice,
          command: pending.command,
        });
        break; // resolve only the oldest matching one
      }
    }

    return found;
  }

  /**
   * Get count of currently pending approvals.
   */
  get pendingCount(): number {
    return this.pendingApprovals.size;
  }

  /**
   * Check if a specific command is currently in the session or always-approve list.
   */
  isCommandApproved(command: string): boolean {
    for (const pattern of this.alwaysApprovePatterns) {
      if (new RegExp(pattern, "i").test(command)) return true;
    }
    for (const approved of this.sessionApprovals) {
      if (command.includes(approved)) return true;
    }
    return false;
  }

  /**
   * Clear all session-level approvals (e.g. on bot restart).
   */
  clearSessionApprovals(): void {
    this.sessionApprovals.clear();
    this.logger.info("Session approvals cleared");
  }

  /**
   * Clear all always-approve patterns.
   */
  clearAlwaysApprovePatterns(): void {
    this.alwaysApprovePatterns.clear();
    this.logger.info("Always-approve patterns cleared");
  }

  /**
   * Manually expire all pending approvals (e.g. on shutdown).
   */
  expireAll(): void {
    for (const [id, pending] of this.pendingApprovals) {
      pending.resolve("deny");
    }
    this.pendingApprovals.clear();
    this.logger.info("All pending approvals expired");
  }
}
