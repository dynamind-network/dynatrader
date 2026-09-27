/**
 * Skill Workshop
 *
 * A proposal queue between the agent and active skill files.
 * Instead of writing directly to SKILL.md, the agent drafts a proposal.
 * The user reviews, evaluates, and approves before anything changes.
 *
 * This prevents uncontrolled self-modification and adds a human-in-the-loop
 * for skill evolution — critical for production safety.
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "expired";

export interface SkillProposal {
  id: string;
  /** The skill being modified (or "new" for creation) */
  skillName: string;
  /** Type of modification */
  action: "create" | "patch" | "edit" | "delete";
  /** Current content of the skill (null for create) */
  currentContent: string | null;
  /** Proposed new content (null for delete) */
  proposedContent: string | null;
  /** For patch: the old/new string pairs */
  patches?: Array<{ old_string: string; new_string: string }>;
  /** Human-readable reason for the proposal */
  reason: string;
  /** When the proposal was created */
  createdAt: Date;
  /** Current status */
  status: ProposalStatus;
  /** User feedback (for rejected/applied) */
  feedback?: string;
  /** When the proposal was resolved */
  resolvedAt?: Date;
  /** Token cost estimate for the change */
  estimatedTokenCost?: number;
}

export interface WorkshopConfig {
  /** Directory to store proposal files */
  proposalsDir: string;
  /** Maximum pending proposals */
  maxPending: number;
  /** Auto-expire proposals after this many days */
  expireAfterDays: number;
  /** Enable/disable the workshop (bypass = direct write) */
  enabled: boolean;
}

export interface WorkshopStats {
  totalProposals: number;
  pending: number;
  approved: number;
  rejected: number;
  applied: number;
  expired: number;
  approvalRate: number;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WorkshopConfig = {
  proposalsDir: "workspace/proposals",
  maxPending: 20,
  expireAfterDays: 7,
  enabled: true,
};

// ---------------------------------------------------------------------------
// SkillWorkshop
// ---------------------------------------------------------------------------

export class SkillWorkshop {
  private readonly config: WorkshopConfig;
  private proposals: Map<string, SkillProposal> = new Map();

  constructor(config?: Partial<WorkshopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Draft a proposal instead of writing directly to SKILL.md.
   * Returns the proposal ID for the user to review.
   */
  async draftProposal(params: {
    skillName: string;
    action: "create" | "patch" | "edit" | "delete";
    currentContent: string | null;
    proposedContent: string | null;
    patches?: Array<{ old_string: string; new_string: string }>;
    reason: string;
  }): Promise<SkillProposal> {
    // Check pending limit
    const pending = this.getPendingProposals();
    if (pending.length >= this.config.maxPending) {
      throw new Error(`Workshop has ${pending.length} pending proposals (max ${this.config.maxPending}). Resolve some before drafting new ones.`);
    }

    const proposal: SkillProposal = {
      id: randomUUID(),
      skillName: params.skillName,
      action: params.action,
      currentContent: params.currentContent,
      proposedContent: params.proposedContent,
      patches: params.patches,
      reason: params.reason,
      createdAt: new Date(),
      status: "pending",
      estimatedTokenCost: this.estimateTokenCost(params.proposedContent, params.patches),
    };

    this.proposals.set(proposal.id, proposal);
    await this.persistProposal(proposal);

    return proposal;
  }

  /**
   * List all proposals (optionally filtered by status).
   */
  listProposals(status?: ProposalStatus): SkillProposal[] {
    const all = Array.from(this.proposals.values());
    if (status) return all.filter((p) => p.status === status);
    return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get a specific proposal by ID.
   */
  getProposal(id: string): SkillProposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * Approve a proposal — marks it ready for application.
   */
  approveProposal(id: string, feedback?: string): SkillProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Proposal ${id} not found`);
    if (proposal.status !== "pending") throw new Error(`Proposal ${id} is ${proposal.status}, not pending`);

    proposal.status = "approved";
    proposal.feedback = feedback;
    proposal.resolvedAt = new Date();

    return proposal;
  }

  /**
   * Reject a proposal with feedback.
   */
  rejectProposal(id: string, feedback?: string): SkillProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Proposal ${id} not found`);
    if (proposal.status !== "pending") throw new Error(`Proposal ${id} is ${proposal.status}, not pending`);

    proposal.status = "rejected";
    proposal.feedback = feedback;
    proposal.resolvedAt = new Date();

    return proposal;
  }

  /**
   * Apply an approved proposal — writes the changes to the skill file.
   */
  async applyProposal(
    id: string,
    writeFn: (skillName: string, content: string) => Promise<void>,
  ): Promise<SkillProposal> {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Proposal ${id} not found`);
    if (proposal.status !== "approved") throw new Error(`Proposal ${id} is ${proposal.status}, not approved`);

    if (proposal.action === "delete") {
      // For delete, write empty content or a deletion marker
      await writeFn(proposal.skillName, "");
    } else if (proposal.proposedContent) {
      await writeFn(proposal.skillName, proposal.proposedContent);
    }

    proposal.status = "applied";
    proposal.resolvedAt = new Date();

    return proposal;
  }

  /**
   * Get pending proposals (oldest first, for user review).
   */
  getPendingProposals(): SkillProposal[] {
    return this.listProposals("pending");
  }

  /**
   * Expire old pending proposals.
   */
  expireOldProposals(): number {
    const cutoff = new Date(Date.now() - this.config.expireAfterDays * 24 * 60 * 60 * 1000);
    let expired = 0;

    for (const proposal of this.proposals.values()) {
      if (proposal.status === "pending" && proposal.createdAt < cutoff) {
        proposal.status = "expired";
        proposal.resolvedAt = new Date();
        expired++;
      }
    }

    return expired;
  }

  /**
   * Get workshop statistics.
   */
  getStats(): WorkshopStats {
    const all = Array.from(this.proposals.values());
    const pending = all.filter((p) => p.status === "pending").length;
    const approved = all.filter((p) => p.status === "approved").length;
    const rejected = all.filter((p) => p.status === "rejected").length;
    const applied = all.filter((p) => p.status === "applied").length;
    const expired = all.filter((p) => p.status === "expired").length;
    const totalResolved = approved + rejected;
    const approvalRate = totalResolved > 0 ? approved / totalResolved : 0;

    return {
      totalProposals: all.length,
      pending,
      approved,
      rejected,
      applied,
      expired,
      approvalRate,
    };
  }

  /**
   * Load proposals from disk on startup.
   */
  async loadFromDisk(): Promise<void> {
    if (!existsSync(this.config.proposalsDir)) return;

    const entries = await fs.readdir(this.config.proposalsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const raw = await fs.readFile(path.join(this.config.proposalsDir, entry.name), "utf-8");
          const proposal = JSON.parse(raw) as SkillProposal;
          proposal.createdAt = new Date(proposal.createdAt);
          if (proposal.resolvedAt) proposal.resolvedAt = new Date(proposal.resolvedAt);
          this.proposals.set(proposal.id, proposal);
        } catch {
          // Skip corrupted files
        }
      }
    }
  }

  /**
   * Enable or disable the workshop at runtime.
   */
  setEnabled(enabled: boolean): void {
    (this.config as { enabled: boolean }).enabled = enabled;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async persistProposal(proposal: SkillProposal): Promise<void> {
    if (!existsSync(this.config.proposalsDir)) {
      await fs.mkdir(this.config.proposalsDir, { recursive: true });
    }
    const filePath = path.join(this.config.proposalsDir, `${proposal.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(proposal, null, 2), "utf-8");
  }

  private estimateTokenCost(
    content: string | null,
    patches?: Array<{ old_string: string; new_string: string }>,
  ): number {
    if (patches) {
      return patches.reduce((sum, p) => sum + p.new_string.length / 4, 0);
    }
    return content ? Math.ceil(content.length / 4) : 0;
  }
}
