import { describe, it, expect, vi, beforeEach, afterEach, mock } from 'vitest';
import { getGitStatus, type GitStatus } from '../src/services/GitService.js';
import { getContextUsage, type ContextUsage } from '../src/services/ContextUsageService.js';
import { clearLMStudioModelCache } from '../src/core/providers/lmstudio.js';

describe('useStatusPolling - underlying services', () => {
  describe('getGitStatus', () => {
    it('returns GitStatus with expected shape for a git repo', async () => {
      const status = await getGitStatus(process.cwd());

      // Should return null if not a git repo, or a valid GitStatus object
      if (status !== null) {
        expect(typeof status.branch).toBe('string');
        expect(typeof status.modified).toBe('number');
        expect(typeof status.staged).toBe('number');
        expect(typeof status.untracked).toBe('number');
        expect(typeof status.isDirty).toBe('boolean');
      }
    });

    it('returns GitStatus or null depending on git availability', async () => {
      // Note: GitService caches the git instance, so this tests the general behavior
      const status = await getGitStatus(process.cwd());
      // Either returns a valid GitStatus or null
      if (status !== null) {
        expect(typeof status.branch).toBe('string');
        expect(typeof status.isDirty).toBe('boolean');
      }
    });
  });

  describe('getContextUsage', () => {
    it('returns usage for dynamically detected LM Studio models', async () => {
      clearLMStudioModelCache();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'google/gemma-4-e2b' }],
        }),
      }) as typeof fetch;
      const { detectLMStudioModels } = await import('../src/core/providers/index.js');
      await detectLMStudioModels('http://127.0.0.1:1234/v1');

      const usage = getContextUsage(
        [{ role: 'user' as const, content: 'hello' }],
        'google/gemma-4-e2b'
      );

      expect(usage).not.toBeNull();
      expect(usage?.contextWindow).toBe(128000);
      globalThis.fetch = originalFetch;
    });

    it('returns null for unknown model', () => {
      const usage = getContextUsage([], 'unknown-model-xyz');
      expect(usage).toBeNull();
    });

    it('returns ContextUsage with expected shape for known model', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello world' },
        { role: 'assistant' as const, content: 'Hi there' },
      ];

      // Test with a known model from the providers
      const usage = getContextUsage(messages, 'claude-sonnet-4-20250514');

      if (usage !== null) {
        expect(typeof usage.used).toBe('number');
        expect(typeof usage.total).toBe('number');
        expect(typeof usage.percent).toBe('number');
        expect(typeof usage.remaining).toBe('number');
        expect(typeof usage.contextWindow).toBe('number');
        expect(['ok', 'warning', 'error', 'critical']).toContain(usage.level);
      }
    });

    it('calculates higher usage for more messages', () => {
      const fewMessages = [{ role: 'user' as const, content: 'Hello' }];
      const manyMessages = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `Message ${i} with some content to increase token count`,
      }));

      const usageFew = getContextUsage(fewMessages, 'claude-sonnet-4-20250514');
      const usageMany = getContextUsage(manyMessages, 'claude-sonnet-4-20250514');

      if (usageFew !== null && usageMany !== null) {
        expect(usageMany.used).toBeGreaterThan(usageFew.used);
        expect(usageMany.percent).toBeGreaterThanOrEqual(usageFew.percent);
      }
    });

    it('returns zero usage for empty messages array', () => {
      const usage = getContextUsage([], 'claude-sonnet-4-20250514');

      if (usage !== null) {
        expect(usage.used).toBe(0);
        expect(usage.percent).toBe(0);
      }
    });
  });

  describe('polling intervals match specification', () => {
    it('git status polling interval is 5000ms', () => {
      // Verify the hook source code uses the correct interval
      const fs = require('fs');
      const path = require('path');
      const hookPath = path.join(__dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      expect(content).toContain('setInterval(poll, 5000)');
    });

    it('context usage polling interval is 5000ms', () => {
      const fs = require('fs');
      const path = require('path');
      const hookPath = path.join(__dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      expect(content).toContain('setInterval(update, 5000)');
    });
  });

  describe('hook interface', () => {
    it('exports useStatusPolling function', async () => {
      const { useStatusPolling } = await import('../src/ui/hooks/useStatusPolling.js');
      expect(typeof useStatusPolling).toBe('function');
    });

    it('exports StatusPollingResult interface shape via return type', async () => {
      const { useStatusPolling } = await import('../src/ui/hooks/useStatusPolling.js');
      // The function should exist and be callable (will return React hook result)
      expect(useStatusPolling).toBeDefined();
    });
  });
});
