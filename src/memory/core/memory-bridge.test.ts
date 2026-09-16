import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryBridge } from './memory-bridge';
import type { MemoryStoreBackend } from '@dyna/memory-core';
import type { MemoryEvent } from '@dyna/memory-core';
import * as fs from 'fs/promises';

vi.mock('fs/promises');

describe('MemoryBridge', () => {
  let bridge: MemoryBridge;
  let mockBackend: MemoryStoreBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBackend = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      search: vi.fn().mockResolvedValue([]),
      compact: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    bridge = new MemoryBridge(mockBackend, {
      memoryMdPath: '/test/workspace/MEMORY.md',
    });
  });

  describe('parseMemoryMd', () => {
    it('should parse markdown sections', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        '# MEMORY.md\n\n## Current Context\nMode: paper\n\n## Recent Decisions\nBought BTC at 50k\n'
      );

      const sections = await bridge.parseMemoryMd();
      expect(sections.length).toBe(3);
      expect(sections[0].heading).toBe('MEMORY.md');
      expect(sections[0].level).toBe(1);
      expect(sections[1].heading).toBe('Current Context');
      expect(sections[1].level).toBe(2);
      expect(sections[2].heading).toBe('Recent Decisions');
    });

    it('should return empty array for missing file', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(fs.readFile).mockRejectedValue(err);

      const sections = await bridge.parseMemoryMd();
      expect(sections).toEqual([]);
    });

    it('should throw for non-ENOENT errors', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied'));

      await expect(bridge.parseMemoryMd()).rejects.toThrow('Permission denied');
    });

    it('should handle single section', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# Title\nSome content here\n');

      const sections = await bridge.parseMemoryMd();
      expect(sections.length).toBe(1);
      expect(sections[0].heading).toBe('Title');
      expect(sections[0].level).toBe(1);
      expect(sections[0].content).toBe('Some content here\n');
    });

    it('should handle empty file', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('');

      const sections = await bridge.parseMemoryMd();
      expect(sections).toEqual([]);
    });

    it('should parse nested heading levels', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        '# H1\n## H2\n### H3\nContent\n'
      );

      const sections = await bridge.parseMemoryMd();
      expect(sections.length).toBe(3);
      expect(sections[0].level).toBe(1);
      expect(sections[1].level).toBe(2);
      expect(sections[2].level).toBe(3);
    });
  });

  describe('syncToSqlite', () => {
    it('should create memory events for sections', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        '# MEMORY.md\n\n## Context\nPaper mode\n'
      );
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      const result = await bridge.syncToSqlite();
      expect(result.sectionsParsed).toBe(2);
      expect(result.entriesSynced).toBe(2);
      expect(mockBackend.put).toHaveBeenCalledTimes(2);
    });

    it('should update existing entries when content changes', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        '# MEMORY.md\n\n## Context\nUpdated mode\n'
      );

      const existingEvent: MemoryEvent = {
        id: 'memmd-existing',
        scope: 'memory_md',
        kind: 'memory_md_section',
        payload: {
          sectionId: 'section-test',
          heading: 'Context',
          level: 2,
          content: 'Old mode',
          source: 'memory_md',
        },
        timestamp: new Date(),
      };

      vi.mocked(mockBackend.search).mockResolvedValue([
        { id: 'memmd-existing', score: 1, payload: existingEvent.payload, timestamp: new Date() },
      ]);
      vi.mocked(mockBackend.get).mockResolvedValue(existingEvent);

      const result = await bridge.syncToSqlite();
      expect(result.entriesUpdated).toBeGreaterThanOrEqual(0);
    });

    it('should return zero counts for empty file', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('');
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      const result = await bridge.syncToSqlite();
      expect(result.sectionsParsed).toBe(0);
      expect(result.entriesSynced).toBe(0);
    });

    it('should track timestamp', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# MEMORY.md\n');
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      const before = new Date();
      const result = await bridge.syncToSqlite();
      const after = new Date();

      expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should include correct scope and kind in put calls', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# MEMORY.md\n');
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      await bridge.syncToSqlite();

      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect(putArg.scope).toBe('memory_md');
      expect(putArg.kind).toBe('memory_md_section');
    });
  });

  describe('generateMemoryMd', () => {
    it('should rebuild MEMORY.md from SQLite entries', async () => {
      vi.mocked(mockBackend.search).mockResolvedValue([
        { id: '1', score: 1, payload: { heading: 'Context', level: 2, content: 'Paper mode' }, timestamp: new Date() },
        { id: '2', score: 1, payload: { heading: 'Decisions', level: 2, content: 'Bought BTC' }, timestamp: new Date() },
      ]);

      vi.mocked(mockBackend.get).mockImplementation(async (id: string) => ({
        id,
        scope: 'memory_md',
        kind: 'memory_md_section',
        payload: id === '1'
          ? { heading: 'Context', level: 2, content: 'Paper mode', lineStart: 0 }
          : { heading: 'Decisions', level: 2, content: 'Bought BTC', lineStart: 3 },
        timestamp: new Date(),
      }));

      const content = await bridge.generateMemoryMd();
      expect(content).toContain('## Context');
      expect(content).toContain('Paper mode');
      expect(content).toContain('## Decisions');
      expect(content).toContain('Bought BTC');
    });

    it('should return default content when no entries exist', async () => {
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      const content = await bridge.generateMemoryMd();
      expect(content).toContain('MEMORY.md');
      expect(content).toContain('Hot Memory');
    });

    it('should skip deleted entries', async () => {
      vi.mocked(mockBackend.search).mockResolvedValue([
        { id: '1', score: 1, payload: { heading: 'Active', level: 2, content: 'Keep this' }, timestamp: new Date() },
        { id: '2', score: 1, payload: { heading: 'Deleted', level: 2, content: 'Remove this' }, timestamp: new Date() },
      ]);

      vi.mocked(mockBackend.get).mockImplementation(async (id: string) => ({
        id,
        scope: 'memory_md',
        kind: id === '2' ? 'memory_md_section:deleted' : 'memory_md_section',
        payload: id === '1'
          ? { heading: 'Active', level: 2, content: 'Keep this', lineStart: 0 }
          : { heading: 'Deleted', level: 2, content: 'Remove this', lineStart: 3 },
        timestamp: new Date(),
      }));

      const content = await bridge.generateMemoryMd();
      expect(content).toContain('Active');
      expect(content).toContain('Keep this');
      expect(content).not.toContain('Deleted');
      expect(content).not.toContain('Remove this');
    });

    it('should sort sections by lineStart', async () => {
      vi.mocked(mockBackend.search).mockResolvedValue([
        { id: '1', score: 1, payload: {}, timestamp: new Date() },
        { id: '2', score: 1, payload: {}, timestamp: new Date() },
      ]);

      vi.mocked(mockBackend.get).mockImplementation(async (id: string) => ({
        id,
        scope: 'memory_md',
        kind: 'memory_md_section',
        payload: id === '1'
          ? { heading: 'Second', level: 2, content: 'B content', lineStart: 5 }
          : { heading: 'First', level: 2, content: 'A content', lineStart: 1 },
        timestamp: new Date(),
      }));

      const content = await bridge.generateMemoryMd();
      const firstIdx = content.indexOf('## First');
      const secondIdx = content.indexOf('## Second');
      expect(firstIdx).toBeLessThan(secondIdx);
    });
  });

  describe('exists', () => {
    it('should return true when file exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      expect(await bridge.exists()).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      expect(await bridge.exists()).toBe(false);
    });
  });

  describe('getLastSyncResult', () => {
    it('should return undefined before any sync', () => {
      expect(bridge.getLastSyncResult()).toBeUndefined();
    });

    it('should return sync result after syncToSqlite', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# MEMORY.md\n');
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      const result = await bridge.syncToSqlite();
      const lastResult = bridge.getLastSyncResult();
      expect(lastResult).toBeDefined();
      expect(lastResult!.sectionsParsed).toBe(result.sectionsParsed);
    });
  });

  describe('config', () => {
    it('should use default scope when not provided', async () => {
      const defaultBridge = new MemoryBridge(mockBackend, {
        memoryMdPath: '/test/MEMORY.md',
      });

      vi.mocked(fs.readFile).mockResolvedValue('# Test\n');
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      await defaultBridge.syncToSqlite();

      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect(putArg.scope).toBe('memory_md');
    });

    it('should use custom scope when provided', async () => {
      const customBridge = new MemoryBridge(mockBackend, {
        memoryMdPath: '/test/MEMORY.md',
        scope: 'custom_scope',
      });

      vi.mocked(fs.readFile).mockResolvedValue('# Test\n');
      vi.mocked(mockBackend.search).mockResolvedValue([]);

      await customBridge.syncToSqlite();

      const putArg = vi.mocked(mockBackend.put).mock.calls[0][0] as MemoryEvent;
      expect(putArg.scope).toBe('custom_scope');
    });
  });
});
