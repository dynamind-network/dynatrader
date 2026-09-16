/**
 * Memory Privacy & Scoping
 *
 * Per-user, per-strategy, or per-session memory isolation.
 * Prevents cross-contamination in multi-strategy environments.
 *
 * Features:
 * - Memory scopes: global, user, strategy, session
 * - Scoped queries (only search within allowed scopes)
 * - Access control lists for memory entries
 * - Inheritance: child scopes inherit parent scope memories
 */

import type { MemoryEvent, MemoryStoreBackend, SearchQuery, SearchResult } from '@dyna/memory-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryScopeType = 'global' | 'user' | 'strategy' | 'session';

export interface MemoryScope {
  /** Scope identifier (e.g., "user:123", "strategy:momentum-v1"). */
  id: string;
  /** Scope type. */
  type: MemoryScopeType;
  /** Parent scope ID (for inheritance). */
  parentId?: string;
  /** Access control list - list of actors allowed to access. */
  acl: string[];
  /** Whether this scope is read-only for non-owners. */
  readOnly?: boolean;
  /** Creation timestamp. */
  createdAt: string;
  /** Last modified timestamp. */
  updatedAt: string;
}

export interface ScopedSearchQuery extends SearchQuery {
  /** Scope IDs to search within. If empty, searches all allowed scopes. */
  scopeIds?: string[];
  /** Actor requesting the search (for ACL filtering). */
  actor?: string;
  /** Whether to include inherited memories from parent scopes. */
  includeInherited?: boolean;
}

export interface ScopedMemoryEvent extends MemoryEvent {
  /** Scope ID where this memory belongs. */
  scopeId: string;
  /** Owner of this memory (actor who created it). */
  owner?: string;
  /** Access level: read, write, admin. */
  accessLevel?: 'read' | 'write' | 'admin';
}

// ---------------------------------------------------------------------------
// MemoryScopeManager
// ---------------------------------------------------------------------------

export class MemoryScopeManager {
  private scopes: Map<string, MemoryScope> = new Map();
  private backend: MemoryStoreBackend;

  constructor(backend: MemoryStoreBackend) {
    this.backend = backend;

    // Create default global scope
    this.scopes.set('global', {
      id: 'global',
      type: 'global',
      acl: ['*'], // Everyone can access
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Create a new memory scope.
   */
  createScope(scope: Omit<MemoryScope, 'createdAt' | 'updatedAt'>): MemoryScope {
    if (this.scopes.has(scope.id)) {
      throw new Error(`Scope "${scope.id}" already exists`);
    }

    // Validate parent exists
    if (scope.parentId && !this.scopes.has(scope.parentId)) {
      throw new Error(`Parent scope "${scope.parentId}" not found`);
    }

    const newScope: MemoryScope = {
      ...scope,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.scopes.set(scope.id, newScope);
    return newScope;
  }

  /**
   * Update an existing scope.
   */
  updateScope(id: string, updates: Partial<Omit<MemoryScope, 'id' | 'createdAt'>>): MemoryScope {
    const scope = this.scopes.get(id);
    if (!scope) {
      throw new Error(`Scope "${id}" not found`);
    }

    const updatedScope: MemoryScope = {
      ...scope,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.scopes.set(id, updatedScope);
    return updatedScope;
  }

  /**
   * Delete a scope and all its memories.
   */
  async deleteScope(id: string): Promise<boolean> {
    if (id === 'global') {
      throw new Error('Cannot delete global scope');
    }

    const scope = this.scopes.get(id);
    if (!scope) {
      return false;
    }

    // Archive all memories in this scope
    const memories = await this.backend.search({ scope: id, limit: 10000 });
    for (const memory of memories) {
      const event = await this.backend.get(memory.id);
      if (event) {
        const payload = event.payload as Record<string, unknown>;
        const archivedEvent: MemoryEvent = {
          ...event,
          kind: `${event.kind}:archived`,
          payload: {
            ...payload,
            archivedAt: new Date().toISOString(),
            archivedReason: 'scope_deleted',
          },
          timestamp: new Date(),
        };
        await this.backend.put(archivedEvent);
      }
    }

    return this.scopes.delete(id);
  }

  /**
   * Get a scope by ID.
   */
  getScope(id: string): MemoryScope | undefined {
    return this.scopes.get(id);
  }

  /**
   * Get all scopes.
   */
  getAllScopes(): MemoryScope[] {
    return Array.from(this.scopes.values());
  }

  /**
   * Get scopes by type.
   */
  getScopesByType(type: MemoryScopeType): MemoryScope[] {
    return this.getAllScopes().filter(s => s.type === type);
  }

  /**
   * Get child scopes of a parent.
   */
  getChildScopes(parentId: string): MemoryScope[] {
    return this.getAllScopes().filter(s => s.parentId === parentId);
  }

  /**
   * Get scope hierarchy (ancestors).
   */
  getScopeHierarchy(scopeId: string): MemoryScope[] {
    const hierarchy: MemoryScope[] = [];
    let current = this.scopes.get(scopeId);

    while (current) {
      hierarchy.unshift(current);
      current = current.parentId ? this.scopes.get(current.parentId) : undefined;
    }

    return hierarchy;
  }

  /**
   * Check if an actor has access to a scope.
   */
  hasAccess(scopeId: string, actor: string, level: 'read' | 'write' | 'admin' = 'read'): boolean {
    const scope = this.scopes.get(scopeId);
    if (!scope) return false;

    // Global scope is accessible to all
    if (scopeId === 'global') return true;

    // Check ACL
    if (scope.acl.includes('*')) return true;
    if (scope.acl.includes(actor)) return true;

    // Check parent scope access
    if (scope.parentId) {
      return this.hasAccess(scope.parentId, actor, level);
    }

    return false;
  }

  /**
   * Get all scope IDs an actor has access to.
   */
  getAccessibleScopes(actor: string, level: 'read' | 'write' | 'admin' = 'read'): string[] {
    return this.getAllScopes()
      .filter(scope => this.hasAccess(scope.id, actor, level))
      .map(scope => scope.id);
  }

  /**
   * Add an actor to a scope's ACL.
   */
  addActorToScope(scopeId: string, actor: string): void {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      throw new Error(`Scope "${scopeId}" not found`);
    }

    if (!scope.acl.includes(actor)) {
      scope.acl.push(actor);
      scope.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Remove an actor from a scope's ACL.
   */
  removeActorFromScope(scopeId: string, actor: string): void {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      throw new Error(`Scope "${scopeId}" not found`);
    }

    scope.acl = scope.acl.filter(a => a !== actor);
    scope.updatedAt = new Date().toISOString();
  }

  /**
   * Store a memory event in a specific scope.
   */
  async putScoped(event: ScopedMemoryEvent): Promise<void> {
    // Validate scope exists
    if (!this.scopes.has(event.scopeId)) {
      throw new Error(`Scope "${event.scopeId}" not found`);
    }

    // Store with scope in the event
    const scopedEvent: MemoryEvent = {
      ...event,
      scope: event.scopeId,
      metadata: {
        ...event.metadata,
        scopeId: event.scopeId,
        owner: event.owner,
        accessLevel: event.accessLevel,
      },
    };

    await this.backend.put(scopedEvent);
  }

  /**
   * Search memories with scope filtering.
   */
  async scopedSearch(query: ScopedSearchQuery): Promise<SearchResult[]> {
    // Determine which scopes to search
    let searchScopeIds: string[];

    if (query.scopeIds && query.scopeIds.length > 0) {
      // Use specified scopes
      searchScopeIds = query.scopeIds;
    } else if (query.actor) {
      // Use all accessible scopes for the actor
      searchScopeIds = this.getAccessibleScopes(query.actor, 'read');
    } else {
      // Search all scopes
      searchScopeIds = Array.from(this.scopes.keys());
    }

    // Include inherited scopes if requested
    if (query.includeInherited) {
      const allScopeIds = new Set(searchScopeIds);
      for (const scopeId of searchScopeIds) {
        const hierarchy = this.getScopeHierarchy(scopeId);
        for (const ancestor of hierarchy) {
          allScopeIds.add(ancestor.id);
        }
      }
      searchScopeIds = Array.from(allScopeIds);
    }

    // Search each scope and combine results
    const allResults: SearchResult[] = [];

    for (const scopeId of searchScopeIds) {
      const scopeQuery: SearchQuery = {
        ...query,
        scope: scopeId,
      };

      const results = await this.backend.search(scopeQuery);
      allResults.push(...results);
    }

    // Deduplicate by ID
    const seen = new Set<string>();
    const uniqueResults: SearchResult[] = [];

    for (const result of allResults) {
      if (!seen.has(result.id)) {
        seen.add(result.id);
        uniqueResults.push(result);
      }
    }

    // Sort by score (descending)
    uniqueResults.sort((a, b) => b.score - a.score);

    // Apply limit
    if (query.limit) {
      return uniqueResults.slice(0, query.limit);
    }

    return uniqueResults;
  }

  /**
   * Get scope statistics.
   */
  async getStats(): Promise<{
    totalScopes: number;
    scopesByType: Record<MemoryScopeType, number>;
    memoriesPerScope: Record<string, number>;
    totalMemories: number;
  }> {
    const scopes = this.getAllScopes();
    const scopesByType: Record<MemoryScopeType, number> = {
      global: 0,
      user: 0,
      strategy: 0,
      session: 0,
    };

    const memoriesPerScope: Record<string, number> = {};
    let totalMemories = 0;

    for (const scope of scopes) {
      scopesByType[scope.type]++;

      const memories = await this.backend.search({ scope: scope.id, limit: 10000 });
      memoriesPerScope[scope.id] = memories.length;
      totalMemories += memories.length;
    }

    return {
      totalScopes: scopes.length,
      scopesByType,
      memoriesPerScope,
      totalMemories,
    };
  }
}
