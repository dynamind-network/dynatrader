/**
 * Skill System Type Definitions
 *
 * Skill types for SKILL.md files with YAML frontmatter,
 * gating, precedence-based loading, and prompt injection.
 */

// ---------------------------------------------------------------------------
// Skill Metadata
// ---------------------------------------------------------------------------

/**
 * YAML frontmatter metadata parsed from a .skill.md file.
 */
export interface SkillMetadata {
  /** Unique skill name used for identification and XML injection. */
  name: string;
  /** Human-readable description of what this skill does. */
  description: string;
  /** Skill category for filtering and organisation. */
  type: 'strategy' | 'analysis' | 'research' | 'risk' | 'utility';
  /** Tags for cross-cutting classification. */
  tags: string[];
  /** Gating requirements that must be satisfied before this skill is enabled. */
  requires?: {
    /** Required executables on PATH (e.g. ["python", "node"]). */
    bins?: string[];
    /** Required environment variables (e.g. ["OPENAI_API_KEY"]). */
    env?: string[];
    /** Required configuration keys (evaluated against a config provider). */
    config?: string[];
  };
  /** Optional OS filter. If set, skill only loads on matching platforms. */
  os?: ('win32' | 'darwin' | 'linux')[];
  /**
   * Confidence threshold (0-1). Skills below this threshold are excluded
   * unless explicitly requested. Defaults to 0.5.
   */
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

/**
 * Precedence level for skill loading.
 * Higher values = lower priority; workspace overrides everything.
 */
export type PrecedenceLevel = 'workspace' | 'project' | 'personal' | 'bundled';

/**
 * Numeric mapping of PrecedenceLevel for easy comparison.
 * Lower number = higher priority (loaded first, overrides later).
 */
export const PRECEDENCE_ORDER: Record<PrecedenceLevel, number> = {
  workspace: 0,
  project: 1,
  personal: 2,
  bundled: 3,
};

/**
 * A fully loaded skill ready for gating and injection.
 */
export interface Skill {
  /** Parsed YAML frontmatter metadata. */
  metadata: SkillMetadata;
  /** Markdown body (instructions) after the frontmatter. */
  instructions: string;
  /** Absolute filesystem path to the source .skill.md file. */
  source: string;
  /** Numeric precedence level (0=workspace, 1=project, 2=personal, 3=bundled). */
  precedence: number;
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a skill's gating requirements.
 */
export interface SkillGateResult {
  /** Whether all gates passed. */
  passed: boolean;
  /** Human-readable reason when a gate fails. */
  reason?: string;
}

/**
 * Configuration provider interface used by gates to check required config keys.
 * Implementations can read from a config object, environment, or a file.
 */
export interface ConfigProvider {
  /** Returns true if the given config key exists and is non-empty. */
  has(key: string): boolean;
}

// ---------------------------------------------------------------------------
// Workshop
// ---------------------------------------------------------------------------

/**
 * Status of a workshop proposal.
 */
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/**
 * A skill proposal submitted through the workshop queue.
 */
export interface SkillProposal {
  /** Unique proposal ID (UUID). */
  id: string;
  /** Proposed skill metadata. */
  metadata: SkillMetadata;
  /** Proposed markdown instructions. */
  instructions: string;
  /** Current status of the proposal. */
  status: ProposalStatus;
  /** Timestamp (epoch ms) when the proposal was created. */
  createdAt: number;
  /** Timestamp (epoch ms) when the proposal was last modified. */
  updatedAt: number;
  /** Human rejection reason (only set when status is 'rejected'). */
  rejectionReason?: string;
}
