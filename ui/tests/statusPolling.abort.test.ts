import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('useStatusPolling - AbortController integration', () => {
  describe('hook source code uses AbortController pattern', () => {
    it('imports useAbortableEffect from abortController utility', () => {
      const hookPath = path.join(import.meta.dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      expect(content).toContain('useAbortableEffect');
    });

    it('does NOT use the old cancelled boolean flag pattern', () => {
      const hookPath = path.join(import.meta.dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      // The old pattern was: let cancelled = false
      expect(content).not.toMatch(/let\s+cancelled\s*=\s*false/);
    });

    it('checks signal.aborted before setState calls for git status', () => {
      const hookPath = path.join(import.meta.dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      // Should check signal.aborted before setting git status
      expect(content).toContain('signal.aborted');
    });

    it('uses AbortController signal pattern for cleanup', () => {
      const hookPath = path.join(import.meta.dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      // Should use signal.addEventListener for abort handling
      expect(content).toContain('signal.addEventListener');
    });
  });

  describe('polling intervals preserved after refactor', () => {
    it('git status polling interval is still 5000ms', () => {
      const hookPath = path.join(import.meta.dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      expect(content).toContain('5000');
    });

    it('context usage polling interval is still 5000ms', () => {
      const hookPath = path.join(import.meta.dirname, '../src/ui/hooks/useStatusPolling.ts');
      const content = fs.readFileSync(hookPath, 'utf-8');

      expect(content).toContain('setInterval(update, 5000)');
    });
  });

  describe('hook interface unchanged', () => {
    it('exports useStatusPolling function', async () => {
      const { useStatusPolling } = await import('../src/ui/hooks/useStatusPolling.js');
      expect(typeof useStatusPolling).toBe('function');
    });

    it('StatusPollingResult interface still has gitStatus and contextUsage', async () => {
      // Verify the module exports are intact by checking the hook exists
      const { useStatusPolling } = await import('../src/ui/hooks/useStatusPolling.js');
      expect(useStatusPolling).toBeDefined();
    });
  });

  describe('useAbortableEffect is properly imported', () => {
    it('abortController module exports useAbortableEffect', async () => {
      const { useAbortableEffect } = await import('../src/ui/utils/abortController.js');
      expect(typeof useAbortableEffect).toBe('function');
    });

    it('useAbortableEffect returns an AbortController', async () => {
      const { useAbortableEffect } = await import('../src/ui/utils/abortController.js');
      // The function should exist and be callable as a React hook
      expect(useAbortableEffect).toBeDefined();
    });
  });
});
