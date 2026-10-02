/**
 * @dyna/memory
 *
 * Memory system for DynaTrader.
 * Provides SQLite-backed storage with FTS5, embedding-based semantic search,
 * consolidation, scope management, and MEMORY.md synchronization.
 */

// Core memory store
export { MemoryStoreImpl } from './core/memory-store';
export type { MemoryEvent, MemoryStoreBackend, SearchQuery, SearchResult } from './core/memory-store';

// SQLite backend
export { SqliteMemoryStore } from './sqlite/sqlite-store';

// Embedding-based semantic search
export { EmbeddingService, EmbeddingMemoryStore } from './embedding/embedding-memory-store';
export type { EmbeddingConfig, EmbeddingSearchQuery, EmbeddingSearchResult } from './embedding/embedding-memory-store';

// Memory consolidation
export { MemoryConsolidation } from './consolidation/memory-consolidation';
export type { ConsolidationConfig, MemoryCluster, ConsolidationResult } from './consolidation/memory-consolidation';

// Memory scope management (privacy/isolation)
export { MemoryScopeManager } from './core/memory-scope-manager';
export type { MemoryScope, MemoryScopeType, ScopedSearchQuery, ScopedMemoryEvent } from './core/memory-scope-manager';

// Memory bridge (MEMORY.md sync)
export { MemoryBridge } from './core/memory-bridge';
export type { MemoryBridgeConfig, ParsedMemorySection, SyncResult } from './core/memory-bridge';

// Memory scorer
export { MemoryScorer, memoryScorer } from './memory-scorer';
export type { MemoryScoreBreakdown } from './memory-scorer';
