/**
 * SkillWorkshop
 *
 * Proposal queue for skill creation and review.
 * Agents propose new skills, humans approve or reject them.
 * Proposals are persisted to a JSON file in the workspace.
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SkillMetadata, SkillProposal, ProposalStatus } from './skill-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROPOSALS_FILE = 'skill-proposals.json';

// ---------------------------------------------------------------------------
// SkillWorkshop
// ---------------------------------------------------------------------------

export class SkillWorkshop {
  private proposals: SkillProposal[] = [];
  private proposalsPath: string;
  private loaded = false;

  /**
   * @param workspacePath - Path to the workspace directory where proposals are persisted.
   */
  constructor(workspacePath: string) {
    this.proposalsPath = path.join(workspacePath, PROPOSALS_FILE);
  }

  // -----------------------------------------------------------------------
  // Proposal lifecycle
  // -----------------------------------------------------------------------

  /**
   * Propose a new skill. The agent submits metadata and instructions;
   * the proposal enters the 'pending' queue for human review.
   *
   * @param metadata - Proposed skill metadata (name, description, type, tags, etc.).
   * @param instructions - Markdown instructions for the skill.
   * @returns The created proposal.
   */
  async proposeSkill(
    metadata: SkillMetadata,
    instructions: string,
  ): Promise<SkillProposal> {
    await this.ensureLoaded();

    const proposal: SkillProposal = {
      id: uuidv4(),
      metadata: {
        name: metadata.name,
        description: metadata.description,
        type: metadata.type,
        tags: [...metadata.tags],
        requires: metadata.requires ? JSON.parse(JSON.stringify(metadata.requires)) : undefined,
        os: metadata.os ? [...metadata.os] : undefined,
        confidence: metadata.confidence ?? 0.5,
      },
      instructions,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.proposals.push(proposal);
    await this.persist();

    return proposal;
  }

  /**
   * Approve a pending proposal by ID.
   *
   * @param skillId - The proposal ID to approve.
   * @returns The updated proposal, or undefined if not found.
   */
  async approveSkill(skillId: string): Promise<SkillProposal | undefined> {
    await this.ensureLoaded();

    const proposal = this.proposals.find((p) => p.id === skillId);
    if (!proposal) return undefined;

    if (proposal.status !== 'pending') {
      return proposal;
    }

    proposal.status = 'approved';
    proposal.updatedAt = Math.max(Date.now(), proposal.updatedAt + 1);
    await this.persist();

    return proposal;
  }

  /**
   * Reject a pending proposal with a reason.
   *
   * @param skillId - The proposal ID to reject.
   * @param reason - Human-readable rejection reason.
   * @returns The updated proposal, or undefined if not found.
   */
  async rejectSkill(
    skillId: string,
    reason: string,
  ): Promise<SkillProposal | undefined> {
    await this.ensureLoaded();

    const proposal = this.proposals.find((p) => p.id === skillId);
    if (!proposal) return undefined;

    if (proposal.status !== 'pending') {
      return proposal;
    }

    proposal.status = 'rejected';
    proposal.rejectionReason = reason;
    proposal.updatedAt = Math.max(Date.now(), proposal.updatedAt + 1);
    await this.persist();

    return proposal;
  }

  // -----------------------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------------------

  /**
   * List proposals, optionally filtered by status.
   *
   * @param status - Optional status filter.
   * @returns Matching proposals, sorted by creation date (newest first).
   */
  async listProposals(status?: ProposalStatus): Promise<SkillProposal[]> {
    await this.ensureLoaded();

    let filtered = this.proposals;
    if (status) {
      filtered = filtered.filter((p) => p.status === status);
    }

    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get a single proposal by ID.
   */
  async getProposal(id: string): Promise<SkillProposal | undefined> {
    await this.ensureLoaded();
    return this.proposals.find((p) => p.id === id);
  }

  /**
   * Get all approved proposals (ready for skill file generation).
   */
  async getApprovedProposals(): Promise<SkillProposal[]> {
    return this.listProposals('approved');
  }

  /**
   * Get all pending proposals (awaiting human review).
   */
  async getPendingProposals(): Promise<SkillProposal[]> {
    return this.listProposals('pending');
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist proposals to the JSON file.
   */
  private async persist(): Promise<void> {
    try {
      const dir = path.dirname(this.proposalsPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        this.proposalsPath,
        JSON.stringify(this.proposals, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.warn('SkillWorkshop: failed to persist proposals', err);
    }
  }

  /**
   * Load proposals from the JSON file (if it exists).
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const raw = await fs.readFile(this.proposalsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.proposals = parsed;
      }
    } catch {
      // File doesn't exist or is invalid -- start fresh.
      this.proposals = [];
    }

    this.loaded = true;
  }
}
