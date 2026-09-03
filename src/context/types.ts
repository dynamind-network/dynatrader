import type {
  ContentType,
  ContentRoute,
  CompressionResult,
  CompressionManifestEntry,
  CCRMarker,
  LiveZoneConfig,
  CacheAlignment,
  CacheBreakpoint,
  SharedContext,
} from '@dyna/contracts';

export type {
  ContentType,
  ContentRoute,
  CompressionResult,
  CompressionManifestEntry,
  CCRMarker,
  LiveZoneConfig,
  CacheAlignment,
  CacheBreakpoint,
  SharedContext,
};

export interface CrusherFieldRule {
  path: string;
  maxTokens: number;
  strategy: 'truncate' | 'summarize' | 'ccr_replace' | 'remove';
  preserveKeys?: string[];
}

export interface LineDecision {
  lineIndex: number;
  action: 'keep' | 'compress' | 'replace_ccr' | 'remove';
  reason: string;
  estimatedTokens: number;
}

export interface PipelineConfig {
  liveZone: LiveZoneConfig;
  rules: CrusherFieldRule[];
  ccrBackend: 'memory' | 'sqlite';
}

export interface ScoredLine {
  text: string;
  score: number;
  contentType: ContentType;
}

// ---------------------------------------------------------------------------
// Compaction Sink — minimal persistence interface for the compaction engine.
// Defined here so context/ has zero dependency on memory/.
// Any object with a compatible `write` method satisfies this interface.
// ---------------------------------------------------------------------------

export interface CompactionSink {
  /** Persist a compaction-related event (pre-compaction flush or record). */
  write(entry: {
    scope: string;
    kind: string;
    payload: unknown;
    timestamp: Date;
  }): Promise<void>;
}
