import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryWriteTool } from './memory-write-tool';
import type { MemoryStoreBackend, MemoryEvent } from '@dyna/memory-core';

describe('MemoryWriteTool', () => {
  let tool: MemoryWriteTool;
  let mockBackend: MemoryStoreBackend;

  beforeEach(() => {
    mockBackend = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      search: vi.fn().mockResolvedValue([]),
      compact: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    tool = new MemoryWriteTool(mockBackend);
  });

  describe('memory_add', () => {
    it('should create a new memory event', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-1',
        args: {
          operation: 'add',
          scope: 'test_scope',
          kind: 'decision',
          payload: { content: 'Test decision' },
          summary: 'A test decision',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect((result.data as any).id).toMatch(/^mem-/);
      expect((result.data as any).scope).toBe('test_scope');
      expect((result.data as any).kind).toBe('decision');
      expect(mockBackend.put).toHaveBeenCalledTimes(1);
    });

    it('should return error when scope is missing', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-2',
        args: {
          operation: 'add',
          kind: 'decision',
          payload: { content: 'Test' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('scope is required');
    });

    it('should return error when kind is missing', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-3',
        args: {
          operation: 'add',
          scope: 'test',
          payload: { content: 'Test' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('kind is required');
    });

    it('should return error when payload is missing', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-4',
        args: {
          operation: 'add',
          scope: 'test',
          kind: 'decision',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('payload is required');
    });

    it('should include summary in payload when provided', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-summary',
        args: {
          operation: 'add',
          scope: 'test_scope',
          kind: 'observation',
          payload: { detail: 'market is volatile' },
          summary: 'Volatile market observation',
        },
      });

      expect(result.success).toBe(true);
      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect((putArg.payload as any)._summary).toBe('Volatile market observation');
    });

    it('should include metadata with addedBy and source', async () => {
      await tool.execute({
        tool: 'memory_write',
        id: 'test-meta',
        args: {
          operation: 'add',
          scope: 'test_scope',
          kind: 'learning',
          payload: { lesson: 'be patient' },
        },
      });

      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect(putArg.metadata).toBeDefined();
      expect(putArg.metadata!.addedBy).toBe('agent');
      expect(putArg.metadata!.source).toBe('memory_write_tool');
    });

    it('should include _addedAt timestamp in payload', async () => {
      await tool.execute({
        tool: 'memory_write',
        id: 'test-ts',
        args: {
          operation: 'add',
          scope: 'test_scope',
          kind: 'context',
          payload: { mode: 'paper' },
        },
      });

      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect((putArg.payload as any)._addedAt).toBeDefined();
      expect(typeof (putArg.payload as any)._addedAt).toBe('string');
    });
  });

  describe('memory_update', () => {
    it('should update an existing memory event', async () => {
      const existingEvent: MemoryEvent = {
        id: 'mem-existing-1',
        scope: 'test_scope',
        kind: 'decision',
        payload: { content: 'Old content' },
        timestamp: new Date(),
      };
      vi.mocked(mockBackend.get).mockResolvedValue(existingEvent);

      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-5',
        args: {
          operation: 'update',
          id: 'mem-existing-1',
          payload: { content: 'New content' },
        },
      });

      expect(result.success).toBe(true);
      expect(mockBackend.put).toHaveBeenCalledTimes(1);
      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect((putArg.payload as any).content).toBe('New content');
      expect((putArg.payload as any)._updatedAt).toBeDefined();
    });

    it('should return error when id is missing', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-6',
        args: {
          operation: 'update',
          payload: { content: 'Test' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('id is required');
    });

    it('should return error when event not found', async () => {
      vi.mocked(mockBackend.get).mockResolvedValue(null);

      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-7',
        args: {
          operation: 'update',
          id: 'nonexistent',
          payload: { content: 'Test' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when payload is missing', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-update-nopayload',
        args: {
          operation: 'update',
          id: 'mem-existing',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('payload is required');
    });

    it('should preserve original scope and kind on update', async () => {
      const existingEvent: MemoryEvent = {
        id: 'mem-preserve',
        scope: 'original_scope',
        kind: 'original_kind',
        payload: { old: 'data' },
        timestamp: new Date(),
      };
      vi.mocked(mockBackend.get).mockResolvedValue(existingEvent);

      await tool.execute({
        tool: 'memory_write',
        id: 'test-preserve',
        args: {
          operation: 'update',
          id: 'mem-preserve',
          payload: { new: 'data' },
        },
      });

      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect(putArg.scope).toBe('original_scope');
      expect(putArg.kind).toBe('original_kind');
    });

    it('should merge payload with existing payload', async () => {
      const existingEvent: MemoryEvent = {
        id: 'mem-merge',
        scope: 'test',
        kind: 'context',
        payload: { key1: 'old', key2: 'keep' },
        timestamp: new Date(),
      };
      vi.mocked(mockBackend.get).mockResolvedValue(existingEvent);

      await tool.execute({
        tool: 'memory_write',
        id: 'test-merge',
        args: {
          operation: 'update',
          id: 'mem-merge',
          payload: { key1: 'new', key3: 'added' },
        },
      });

      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect((putArg.payload as any).key1).toBe('new');
      expect((putArg.payload as any).key2).toBe('keep');
      expect((putArg.payload as any).key3).toBe('added');
    });
  });

  describe('memory_remove', () => {
    it('should soft-delete a memory event', async () => {
      const existingEvent: MemoryEvent = {
        id: 'mem-delete-1',
        scope: 'test_scope',
        kind: 'learning',
        payload: { content: 'To be deleted' },
        timestamp: new Date(),
      };
      vi.mocked(mockBackend.get).mockResolvedValue(existingEvent);

      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-8',
        args: {
          operation: 'remove',
          id: 'mem-delete-1',
        },
      });

      expect(result.success).toBe(true);
      expect(mockBackend.put).toHaveBeenCalledTimes(1);
      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect(putArg.kind).toBe('learning:deleted');
      expect((putArg.payload as any)._deleted).toBe(true);
      expect((putArg.payload as any)._deletedAt).toBeDefined();
    });

    it('should return error when id is missing', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-9',
        args: {
          operation: 'remove',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('id is required');
    });

    it('should return error when event not found', async () => {
      vi.mocked(mockBackend.get).mockResolvedValue(null);

      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-10',
        args: {
          operation: 'remove',
          id: 'nonexistent',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should preserve original scope and kind in response', async () => {
      const existingEvent: MemoryEvent = {
        id: 'mem-delete-scope',
        scope: 'my_scope',
        kind: 'my_kind',
        payload: { x: 1 },
        timestamp: new Date(),
      };
      vi.mocked(mockBackend.get).mockResolvedValue(existingEvent);

      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-delete-scope',
        args: {
          operation: 'remove',
          id: 'mem-delete-scope',
        },
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.scope).toBe('my_scope');
      expect(data.kind).toBe('my_kind');
    });
  });

  describe('validation', () => {
    it('should return error for invalid operation', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-11',
        args: {
          operation: 'invalid',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('operation must be one of');
    });

    it('should return error for missing operation', async () => {
      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-no-op',
        args: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('operation must be one of');
    });
  });

  describe('backend error handling', () => {
    it('should handle backend.put errors gracefully', async () => {
      vi.mocked(mockBackend.put).mockRejectedValue(new Error('Disk full'));

      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-backend-err',
        args: {
          operation: 'add',
          scope: 'test',
          kind: 'decision',
          payload: { content: 'Test' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Disk full');
    });

    it('should handle backend.get errors gracefully on update', async () => {
      vi.mocked(mockBackend.get).mockRejectedValue(new Error('Connection lost'));

      const result = await tool.execute({
        tool: 'memory_write',
        id: 'test-get-err',
        args: {
          operation: 'update',
          id: 'mem-123',
          payload: { content: 'Test' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection lost');
    });
  });
});
