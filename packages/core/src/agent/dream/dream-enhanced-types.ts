/**
 * Dream Cycle — Enhanced Types
 *
 * Extended types for taint-gating, two-layer knowledge,
 * contradiction detection, and trust scoring.
 */

export type TrustLevel = 'verified' | 'observed' | 'untrusted' | 'system';

export interface TrustableEntry {
  id: string;
  trustLevel: TrustLevel;
  trustScore: number;
  source: string;
  createdAt: string;
}

export interface TaintGateConfig {
  minTrustLevel: TrustLevel;
  minTrustScore: number;
  taintBoost: number;
  taintPenalty: number;
}

export const DEFAULT_TAINT_GATE_CONFIG: TaintGateConfig = {
  minTrustLevel: 'observed',
  minTrustScore: 0.3,
  taintBoost: 0.05,
  taintPenalty: -0.10,
};

export interface KnowledgeLayer {
  name: string;
  type: 'raw' | 'compiled';
  path: string;
  description: string;
}

export const KNOWLEDGE_LAYERS: KnowledgeLayer[] = [
  { name: 'daily-notes', type: 'raw', path: 'memory/notes', description: 'Raw daily observations and trade notes' },
  { name: 'compiled-wiki', type: 'compiled', path: 'memory/wiki', description: 'Curated knowledge with claims and evidence' },
];

export interface Claim {
  id: string;
  text: string;
  status: 'active' | 'validated' | 'invalidated' | 'expired';
  confidence: number;
  evidence: ClaimEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface ClaimEvidence {
  id: string;
  sourceId: string;
  weight: number;
  confidence: number;
  path?: string;
  lines?: [number, number];
}

export interface Contradiction {
  claimId1: string;
  claimId2: string;
  type: 'direct' | 'indirect' | 'temporal';
  description: string;
  detectedAt: string;
  resolved: boolean;
}

export interface TrustScoring {
  targetId: string;
  helpful: boolean;
  timestamp: string;
  feedback?: string;
}

export const TRUST_WEIGHTS = {
  helpful: 0.05,
  unhelpful: -0.10,
  verifiedTrade: 0.10,
  failedTrade: -0.075,
} as const;
