/**
 * DynaMind Eval Suite — Tool Profiles (eval-specific layer)
 *
 * Imports canonical tool profiles from src/runtime/tools/tool-profiles.ts
 * and adds eval-specific classification logic (family → profile mapping).
 *
 * Architecture: the eval harness uses the SAME tool profile system as the
 * core runtime. No duplicate definitions.
 */

import type { EvalFamily } from './types';
import {
  resolveProfiles as resolveProfilesCore,
  getToolsForProfiles as getToolsForProfilesCore,
  type ToolProfile,
} from '../../src/runtime/tools/tool-profiles';

// Re-export core types for eval consumers
export type { ToolProfile } from '../../src/runtime/tools/tool-profiles';

// ---------------------------------------------------------------------------
// Eval-specific: Family → Profile Mapping
// ---------------------------------------------------------------------------

/**
 * Maps eval scenario family to the required tool profiles.
 *
 * All families get 'base' (file ops + web) as the foundation.
 * Memory and multi-agent are core capabilities — always available.
 * Trading plugin tools are only exposed for trading scenarios.
 */
const FAMILY_PROFILES: Record<EvalFamily, ToolProfile[]> = {
  market_understanding: ['base'],
  tool_selection: ['base'],
  trading_decision: ['base', 'memory'],
  memory: ['base', 'memory'],
  multi_agent: ['base', 'multi_agent'],
  // New system-stack families
  tool_pipeline: ['base', 'memory', 'trading'],
  memory_recall: ['base', 'memory'],
  multi_agent_coordination: ['base', 'multi_agent', 'memory'],
  profile_resolution: ['full'],
};

// ---------------------------------------------------------------------------
// Eval-specific Classifier
// ---------------------------------------------------------------------------

export interface ToolProfileResult {
  profiles: ToolProfile[];
  allowedTools: string[];
  reasoning: string;
}

/**
 * Classifies a scenario and determines which tools the agent should have.
 *
 * Uses the scenario's family to determine tool profiles. This is a
 * rule-based classifier (no LLM call) for zero overhead.
 */
export function classifyToolProfiles(family: EvalFamily): ToolProfileResult {
  const profiles = FAMILY_PROFILES[family] ?? ['base'];
  const allowedTools = getToolsForProfilesCore(resolveProfilesCore(profiles));

  const reasoning = `Family "${family}" → profiles [${profiles.join(', ')}] → ${allowedTools.length} tools`;

  return { profiles, allowedTools, reasoning };
}

/**
 * Gets all tool names for a set of profiles.
 * Delegates to canonical implementation in src/.
 */
export function getToolsForProfiles(profiles: ToolProfile[]): string[] {
  return getToolsForProfilesCore(resolveProfilesCore(profiles));
}

/**
 * Checks if a tool call is allowed given the active profiles.
 */
export function isToolAllowed(toolName: string, profiles: ToolProfile[]): boolean {
  const allowed = getToolsForProfiles(profiles);
  return allowed.includes(toolName);
}

/**
 * Gets the default tool profiles for a family (can be overridden per-scenario).
 */
export function getDefaultProfiles(family: EvalFamily): ToolProfile[] {
  return FAMILY_PROFILES[family] ?? ['base'];
}
