import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('useAgentState hook', () => {
  describe('hook file exists and exports', () => {
    it('exports useAgentState function', async () => {
      const { useAgentState } = await import('../src/ui/hooks/useState/useAgentState.js');
      expect(typeof useAgentState).toBe('function');
    });
  });

  describe('source code structure', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useState/useAgentState.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('imports useRef from react', () => {
      expect(content).toContain('useRef');
    });

    it('imports useCallback from react', () => {
      expect(content).toContain('useCallback');
    });

    it('exports useAgentState function', () => {
      expect(content).toContain('export function useAgentState');
    });

    it('does NOT import useState (pure refs, no state)', () => {
      // The hook should only use refs, not useState
      // Verify useState is NOT imported from react
      const reactImportMatch = content.match(/import.*\{([^}]+)\}.*from 'react'/);
      if (reactImportMatch) {
        expect(reactImportMatch[1]).not.toContain('useState');
      }
    });

    // --- Refs ---

    it('creates commandInFlightRef with boolean initial value false', () => {
      expect(content).toContain('commandInFlightRef');
      expect(content).toContain('useRef<boolean>(false)');
    });

    it('creates activeRunIdRef with string | null initial value null', () => {
      expect(content).toContain('activeRunIdRef');
      expect(content).toContain('useRef<string | null>(null)');
    });

    it('creates activeThinkingMessageIdRef with string | null initial value null', () => {
      expect(content).toContain('activeThinkingMessageIdRef');
      expect(content).toContain('useRef<string | null>(null)');
    });

    it('creates pendingToolMessageIdsRef with Map initial value', () => {
      expect(content).toContain('pendingToolMessageIdsRef');
      expect(content).toContain('useRef<Map<string, string[]>>(new Map())');
    });

    // --- resetAgentState ---

    it('defines resetAgentState as useCallback', () => {
      expect(content).toContain('resetAgentState');
      expect(content).toContain('useCallback');
    });

    it('resetAgentState clears activeRunIdRef', () => {
      expect(content).toContain('activeRunIdRef.current = null');
    });

    it('resetAgentState clears activeThinkingMessageIdRef', () => {
      expect(content).toContain('activeThinkingMessageIdRef.current = null');
    });

    it('resetAgentState clears pendingToolMessageIdsRef', () => {
      expect(content).toContain('pendingToolMessageIdsRef.current.clear()');
    });

    it('resetAgentState does NOT clear commandInFlightRef (managed by submitCommand)', () => {
      // commandInFlightRef is managed externally by submitCommand
      // so resetAgentState should not touch it
      const resetBlockMatch = content.match(
        /const resetAgentState = useCallback\(\(\) => \{([^}]+)\}/
      );
      if (resetBlockMatch) {
        expect(resetBlockMatch[1]).not.toContain('commandInFlightRef');
      }
    });

    // --- Return type ---

    it('returns commandInFlightRef', () => {
      expect(content).toContain('commandInFlightRef,');
    });

    it('returns activeRunIdRef', () => {
      expect(content).toContain('activeRunIdRef,');
    });

    it('returns activeThinkingMessageIdRef', () => {
      expect(content).toContain('activeThinkingMessageIdRef,');
    });

    it('returns pendingToolMessageIdsRef', () => {
      expect(content).toContain('pendingToolMessageIdsRef,');
    });

    it('returns resetAgentState', () => {
      expect(content).toContain('resetAgentState,');
    });

    // --- Types ---

    it('exports AgentExecutionRefs interface', () => {
      expect(content).toContain('export interface AgentExecutionRefs');
    });

    it('exports AgentStateResult interface', () => {
      expect(content).toContain('export interface AgentStateResult');
    });

    it('AgentExecutionRefs includes commandInFlightRef type', () => {
      expect(content).toContain('commandInFlightRef: React.MutableRefObject<boolean>');
    });

    it('AgentExecutionRefs includes activeRunIdRef type', () => {
      expect(content).toContain('activeRunIdRef: React.MutableRefObject<string | null>');
    });

    it('AgentExecutionRefs includes activeThinkingMessageIdRef type', () => {
      expect(content).toContain(
        'activeThinkingMessageIdRef: React.MutableRefObject<string | null>'
      );
    });

    it('AgentExecutionRefs includes pendingToolMessageIdsRef type', () => {
      expect(content).toContain(
        'pendingToolMessageIdsRef: React.MutableRefObject<Map<string, string[]>>'
      );
    });

    it('AgentStateResult extends AgentExecutionRefs', () => {
      expect(content).toContain('export interface AgentStateResult extends AgentExecutionRefs');
    });

    it('AgentStateResult includes resetAgentState type', () => {
      expect(content).toContain('resetAgentState: () => void');
    });

    // --- No external dependencies ---

    it('does not import from other project modules (self-contained)', () => {
      // The hook should only import from react
      const importMatches = content.match(/^import .+ from .+$/gm);
      if (importMatches) {
        for (const imp of importMatches) {
          expect(imp).toMatch(/from 'react'/);
        }
      }
    });

    it('useAgentState takes no arguments', () => {
      expect(content).toContain('export function useAgentState()');
    });
  });

  describe('App.tsx post-integration state', () => {
    const appPath = join(__dirname, '../src/ui/App.tsx');
    let content: string;

    beforeEach(() => {
      content = readFileSync(appPath, 'utf-8');
    });

    // After integration, App.tsx uses useAgentState() instead of inline refs.

    it('hook file is importable', async () => {
      const mod = await import('../src/ui/hooks/useState/useAgentState.js');
      expect(typeof mod.useAgentState).toBe('function');
    });

    it('App.tsx imports useAgentState', () => {
      expect(content).toContain('useAgentState');
    });

    it('App.tsx destructures resetAgentState from useAgentState', () => {
      expect(content).toContain('resetAgentState,');
    });

    it('App.tsx no longer has inline commandInFlightRef declaration', () => {
      // The ref is now inside useAgentState hook, not declared inline in App.tsx
      const lines = content.split('\n');
      const hasInline = lines.some(
        (line) =>
          line.includes('const commandInFlightRef = useRef<boolean>(false)') && !line.includes('//')
      );
      expect(hasInline).toBe(false);
    });

    it('App.tsx no longer has inline activeRunIdRef declaration', () => {
      const lines = content.split('\n');
      const hasInline = lines.some(
        (line) =>
          line.includes('const activeRunIdRef = useRef<string | null>(null)') &&
          !line.includes('//')
      );
      expect(hasInline).toBe(false);
    });

    it('App.tsx no longer has inline activeThinkingMessageIdRef declaration', () => {
      const lines = content.split('\n');
      const hasInline = lines.some(
        (line) =>
          line.includes('const activeThinkingMessageIdRef = useRef<string | null>(null)') &&
          !line.includes('//')
      );
      expect(hasInline).toBe(false);
    });

    it('App.tsx no longer has inline pendingToolMessageIdsRef declaration', () => {
      const lines = content.split('\n');
      const hasInline = lines.some(
        (line) =>
          line.includes(
            'const pendingToolMessageIdsRef = useRef<Map<string, string[]>>(new Map())'
          ) && !line.includes('//')
      );
      expect(hasInline).toBe(false);
    });

    it('resetAgentState() is used in session lifecycle hook instead of inline reset in App.tsx', () => {
      // After integration, resetAgentState() lives in useSessionLifecycle.ts
      const lifecycleContent = readFileSync(
        join(__dirname, '../src/ui/hooks/useSessionLifecycle.ts'),
        'utf-8'
      );
      expect(lifecycleContent).toContain('resetAgentState()');
    });
  });
});
