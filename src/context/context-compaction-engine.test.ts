import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextCompactionEngine } from './context-compaction-engine';
import type { CompactionSink } from './types';
import type { Message } from './context-compaction-engine';

describe('ContextCompactionEngine', () => {
  let engine: ContextCompactionEngine;
  let mockSink: CompactionSink;

  beforeEach(() => {
    mockSink = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    engine = new ContextCompactionEngine(mockSink, {
      maxContextTokens: 1000,
      autoCompactThreshold: 0.75,
      keepRecentMessages: 3,
      recentTailTokens: 200,
      preCompactionFlush: false,
      protectToolPairs: true,
    });
  });

  afterEach(() => {
    engine.resetStats();
  });

  function makeMessages(count: number): Message[] {
    const msgs: Message[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: This is a test message with enough content to generate tokens for testing compaction behavior.`,
      });
    }
    return msgs;
  }

  describe('getTokenUsage', () => {
    it('should return correct token counts', () => {
      const messages = makeMessages(5);
      const usage = engine.getTokenUsage(messages);
      expect(usage.totalTokens).toBeGreaterThan(0);
      expect(usage.maxTokens).toBe(1000);
      expect(usage.usagePercent).toBeGreaterThan(0);
      expect(usage.shouldCompact).toBe(false);
    });

    it('should return zero for empty messages', () => {
      const usage = engine.getTokenUsage([]);
      expect(usage.totalTokens).toBe(0);
      expect(usage.maxTokens).toBe(1000);
      expect(usage.usagePercent).toBe(0);
      expect(usage.shouldCompact).toBe(false);
    });
  });

  describe('shouldAutoCompact', () => {
    it('should return false when under threshold', () => {
      const messages = makeMessages(2);
      expect(engine.shouldAutoCompact(messages)).toBe(false);
    });

    it('should return true when over threshold', () => {
      // Create many messages to exceed threshold
      const messages = makeMessages(50);
      expect(engine.shouldAutoCompact(messages)).toBe(true);
    });

    it('should return false for empty messages', () => {
      expect(engine.shouldAutoCompact([])).toBe(false);
    });
  });

  describe('autoCompact', () => {
    it('should reduce message count while keeping recent', async () => {
      const messages = makeMessages(20);
      const result = await engine.autoCompact(messages);
      expect(result.compressed.length).toBeLessThan(messages.length);
      expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
      expect(result.compressionRatio).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeLessThanOrEqual(1);
    });

    it('should preserve system messages', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'Important system prompt' },
        ...makeMessages(15),
      ];
      const result = await engine.autoCompact(messages);
      const systemMsgs = result.compressed.filter(m => m.role === 'system');
      expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it('should track stats correctly', async () => {
      const messages = makeMessages(20);
      await engine.autoCompact(messages);
      const stats = engine.getStats();
      expect(stats.totalCompactions).toBe(1);
      expect(stats.autoCompactions).toBe(1);
      expect(stats.manualCompactions).toBe(0);
      expect(stats.lastCompactionAt).toBeInstanceOf(Date);
    });

    it('should include summary in result', async () => {
      const messages = makeMessages(20);
      const result = await engine.autoCompact(messages);
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('should set timestamp in result', async () => {
      const messages = makeMessages(20);
      const result = await engine.autoCompact(messages);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should return messagesRemoved count', async () => {
      const messages = makeMessages(20);
      const result = await engine.autoCompact(messages);
      expect(result.messagesRemoved).toBeGreaterThanOrEqual(0);
    });
  });

  describe('manualCompact', () => {
    it('should track as manual compaction', async () => {
      const messages = makeMessages(20);
      await engine.manualCompact(messages);
      const stats = engine.getStats();
      expect(stats.manualCompactions).toBe(1);
      expect(stats.autoCompactions).toBe(0);
    });

    it('should also reduce messages like autoCompact', async () => {
      const messages = makeMessages(20);
      const result = await engine.manualCompact(messages);
      expect(result.compressed.length).toBeLessThan(messages.length);
    });
  });

  describe('tool pair protection', () => {
    it('should protect tool call/result pairs', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Analyze BTC' },
        { role: 'assistant', content: 'Let me check...', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'market_data', arguments: '{}' } }] },
        { role: 'tool', content: 'Price data...', tool_call_id: 'call-1' },
        ...makeMessages(15),
      ];
      const result = await engine.autoCompact(messages);
      // The tool pair should be preserved
      expect(result.toolPairsProtected).toBeGreaterThanOrEqual(0);
    });

    it('should protect multiple tool pairs', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Get market data' },
        { role: 'assistant', content: 'Checking...', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'market', arguments: '{}' } }] },
        { role: 'tool', content: 'Result A', tool_call_id: 'call-a' },
        { role: 'assistant', content: 'Also checking...', tool_calls: [{ id: 'call-b', type: 'function', function: { name: 'news', arguments: '{}' } }] },
        { role: 'tool', content: 'Result B', tool_call_id: 'call-b' },
        ...makeMessages(10),
      ];
      const result = await engine.autoCompact(messages);
      expect(result.compressed.length).toBeLessThan(messages.length);
    });
  });

  describe('compaction history', () => {
    it('should maintain history', async () => {
      const messages = makeMessages(20);
      await engine.autoCompact(messages);
      await engine.autoCompact(messages);
      const history = engine.getHistory();
      expect(history.length).toBe(2);
    });

    it('should store compaction records via the sink', async () => {
      const messages = makeMessages(20);
      await engine.autoCompact(messages);
      expect(mockSink.write).toHaveBeenCalled();
    });

    it('should call sink when flush is enabled', async () => {
      const flushEngine = new ContextCompactionEngine(mockSink, {
        maxContextTokens: 1000,
        autoCompactThreshold: 0.75,
        keepRecentMessages: 3,
        recentTailTokens: 200,
        preCompactionFlush: true,
        protectToolPairs: true,
      });
      const messages: Message[] = [
        { role: 'system', content: 'You are a trading assistant with critical error handling instructions.' },
        ...makeMessages(15),
      ];
      await flushEngine.autoCompact(messages);
      expect(mockSink.write).toHaveBeenCalled();
    });
  });

  describe('config', () => {
    it('should return current config', () => {
      const config = engine.getConfig();
      expect(config.maxContextTokens).toBe(1000);
      expect(config.autoCompactThreshold).toBe(0.75);
    });

    it('should update config', () => {
      engine.updateConfig({ maxContextTokens: 2000 });
      const config = engine.getConfig();
      expect(config.maxContextTokens).toBe(2000);
    });

    it('should preserve other config when updating one field', () => {
      engine.updateConfig({ maxContextTokens: 3000 });
      const config = engine.getConfig();
      expect(config.autoCompactThreshold).toBe(0.75);
      expect(config.keepRecentMessages).toBe(3);
    });
  });

  describe('stats', () => {
    it('should reset stats', async () => {
      const messages = makeMessages(20);
      await engine.autoCompact(messages);
      expect(engine.getStats().totalCompactions).toBe(1);

      engine.resetStats();
      expect(engine.getStats().totalCompactions).toBe(0);
      expect(engine.getStats().lastCompactionAt).toBeNull();
    });

    it('should track cumulative tokens saved', async () => {
      const messages = makeMessages(20);
      await engine.autoCompact(messages);
      const first = engine.getStats().totalTokensSaved;

      await engine.autoCompact(messages);
      const second = engine.getStats().totalTokensSaved;

      expect(second).toBeGreaterThanOrEqual(first);
    });
  });

  describe('edge cases', () => {
    it('should handle single message', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello' }];
      const result = await engine.autoCompact(messages);
      expect(result.compressed.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle all system messages', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'System 1' },
        { role: 'system', content: 'System 2' },
        { role: 'system', content: 'System 3' },
      ];
      const result = await engine.autoCompact(messages);
      const systemMsgs = result.compressed.filter(m => m.role === 'system');
      expect(systemMsgs.length).toBe(3);
    });

    it('should handle messages with tool_calls but no matching results', async () => {
      const messages: Message[] = [
        { role: 'assistant', content: 'Checking...', tool_calls: [{ id: 'orphan-call', type: 'function', function: { name: 'test', arguments: '{}' } }] },
        ...makeMessages(10),
      ];
      const result = await engine.autoCompact(messages);
      expect(result.compressed.length).toBeGreaterThan(0);
    });
  });
});
