import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { MemoryStoreBackend, MemoryEvent } from '@dyna/memory-core';

/**
 * MemoryWriteTool provides agent-driven memory management with three operations:
 * - memory_add: Add a new memory event to SQLite
 * - memory_update: Update an existing memory event's payload
 * - memory_remove: Delete a memory event by ID
 *
 * All operations persist to the SQLite backend (cold storage).
 * The agent can use this to curate MEMORY.md content and maintain
 * a clean, searchable knowledge base.
 */
export class MemoryWriteTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'memory_write',
    description: 'Write, update, or remove memory entries. Use operation="add" to create, "update" to modify, "remove" to delete.',
    category: 'memory',
    inputSchema: {
      operation: 'string',  // "add" | "update" | "remove"
      scope: 'string?',     // required for add
      kind: 'string?',      // required for add (e.g., "decision", "learning", "observation", "context")
      payload: 'object?',   // required for add/update - the data to store
      id: 'string?',        // required for update/remove
      summary: 'string?',   // optional human-readable summary for add
    },
    outputSchema: { success: 'boolean', id: 'string?', message: 'string' },
    permissionsRequired: ['memory.write'],
    sideEffects: ['memory_persist'],
    riskLevel: 'low',
    timeoutMs: 10000,
  };

  constructor(private memoryBackend: MemoryStoreBackend) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const operation = call.args.operation as string | undefined;
      if (!operation || !['add', 'update', 'remove'].includes(operation)) {
        return {
          success: false,
          error: 'operation must be one of: add, update, remove',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      switch (operation) {
        case 'add':
          return await this.handleAdd(call, start);
        case 'update':
          return await this.handleUpdate(call, start);
        case 'remove':
          return await this.handleRemove(call, start);
        default:
          return {
            success: false,
            error: `Unknown operation: ${operation}`,
            durationMs: Date.now() - start,
            truncated: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }

  private async handleAdd(call: ToolCall, start: number): Promise<ToolResult> {
    const scope = call.args.scope as string | undefined;
    if (!scope || typeof scope !== 'string') {
      return {
        success: false,
        error: 'scope is required for add operation',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const kind = call.args.kind as string | undefined;
    if (!kind || typeof kind !== 'string') {
      return {
        success: false,
        error: 'kind is required for add operation (e.g., "decision", "learning", "observation", "context")',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const payload = call.args.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      return {
        success: false,
        error: 'payload is required for add operation',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const summary = call.args.summary as string | undefined;

    const event: MemoryEvent = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      scope,
      kind,
      payload: {
        ...payload,
        ...(summary ? { _summary: summary } : {}),
        _addedAt: new Date().toISOString(),
      },
      timestamp: new Date(),
      metadata: {
        addedBy: 'agent',
        source: 'memory_write_tool',
      },
    };

    await this.memoryBackend.put(event);

    return {
      success: true,
      data: {
        id: event.id,
        message: `Added ${kind} memory to scope "${scope}"`,
        scope,
        kind,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleUpdate(call: ToolCall, start: number): Promise<ToolResult> {
    const id = call.args.id as string | undefined;
    if (!id || typeof id !== 'string') {
      return {
        success: false,
        error: 'id is required for update operation',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const payload = call.args.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      return {
        success: false,
        error: 'payload is required for update operation',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Get existing event
    const existing = await this.memoryBackend.get(id);
    if (!existing) {
      return {
        success: false,
        error: `Memory event not found: ${id}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Merge payload (preserving original metadata)
    const updatedEvent: MemoryEvent = {
      ...existing,
      payload: {
        ...(existing.payload as Record<string, unknown>),
        ...payload,
        _updatedAt: new Date().toISOString(),
      },
      timestamp: new Date(), // Update timestamp to reflect modification
    };

    await this.memoryBackend.put(updatedEvent);

    return {
      success: true,
      data: {
        id,
        message: `Updated memory event ${id}`,
        scope: existing.scope,
        kind: existing.kind,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleRemove(call: ToolCall, start: number): Promise<ToolResult> {
    const id = call.args.id as string | undefined;
    if (!id || typeof id !== 'string') {
      return {
        success: false,
        error: 'id is required for remove operation',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Check if event exists
    const existing = await this.memoryBackend.get(id);
    if (!existing) {
      return {
        success: false,
        error: `Memory event not found: ${id}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Soft delete: mark as deleted rather than actually removing
    // This preserves the event for audit trail but excludes it from search
    const deletedEvent: MemoryEvent = {
      ...existing,
      payload: {
        ...(existing.payload as Record<string, unknown>),
        _deleted: true,
        _deletedAt: new Date().toISOString(),
      },
      kind: `${existing.kind}:deleted`,
      timestamp: new Date(),
    };

    await this.memoryBackend.put(deletedEvent);

    return {
      success: true,
      data: {
        id,
        message: `Removed memory event ${id} (soft deleted)`,
        scope: existing.scope,
        kind: existing.kind,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }
}
