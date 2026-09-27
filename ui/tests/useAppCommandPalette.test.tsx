import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('useAppCommandPalette hook', () => {
  describe('hook file exists and exports', () => {
    it('exports useAppCommandPalette function', async () => {
      const { useAppCommandPalette } = await import('../src/ui/hooks/useAppCommandPalette.js');
      expect(typeof useAppCommandPalette).toBe('function');
    });
  });

  describe('source code structure', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAppCommandPalette.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('imports useMemo from react', () => {
      expect(content).toContain("import { useMemo, useRef, useEffect } from 'react'");
    });

    it('imports CommandItem type', () => {
      expect(content).toContain('import type { CommandItem }');
    });

    it('defines ScreenTarget interface', () => {
      expect(content).toContain('interface ScreenTarget');
    });

    it('defines CommandTarget interface', () => {
      expect(content).toContain('interface CommandTarget');
    });

    it('defines screenTargets with useMemo', () => {
      expect(content).toContain('const screenTargets: ScreenTarget[]');
      expect(content).toContain('useMemo(');
    });

    it('defines commandTargets with useMemo', () => {
      expect(content).toContain('const commandTargets: CommandTarget[]');
    });

    it('returns useMemo with all entry types', () => {
      expect(content).toContain('return useMemo(() => {');
      expect(content).toContain('sessionTargets');
      expect(content).toContain('agentTargets');
    });
  });

  describe('screen targets', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAppCommandPalette.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('defines screen target entries with all expected screen IDs', () => {
      expect(content).toContain("id: 'chat'");
      expect(content).toContain("id: 'help'");
      expect(content).toContain("id: 'markets'");
      expect(content).toContain("id: 'portfolio'");
      expect(content).toContain("id: 'trades'");
      expect(content).toContain("id: 'alerts'");
      expect(content).toContain("id: 'analysis'");
      expect(content).toContain("id: 'news'");
      expect(content).toContain("id: 'watchlist'");
      expect(content).toContain("id: 'chart'");
      expect(content).toContain("id: 'search'");
      expect(content).toContain("id: 'settings'");
      expect(content).toContain("id: 'models'");
      expect(content).toContain("id: 'orderbook'");
      expect(content).toContain("id: 'autohedge'");
    });

    it('maps screen targets to group screen with onSetScreen action', () => {
      expect(content).toContain("group: 'screen' as const");
      expect(content).toContain('onSetScreen(item.screen)');
    });

    it('defines chat screen with correct screen value', () => {
      expect(content).toContain("screen: 'chat'");
    });

    it('defines markets screen with correct screen value', () => {
      expect(content).toContain("screen: 'markets'");
    });
  });

  describe('command targets', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAppCommandPalette.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('defines command target entries with all expected command IDs', () => {
      expect(content).toContain("id: 'help-cmd'");
      expect(content).toContain("id: 'compact-cmd'");
      expect(content).toContain("id: 'resume-list'");
      expect(content).toContain("id: 'tools-cmd'");
      expect(content).toContain("id: 'mcp-cmd'");
      expect(content).toContain("id: 'agents-cmd'");
      expect(content).toContain("id: 'plan-cmd'");
    });

    it('maps command targets to group command with onSubmitCommand action', () => {
      expect(content).toContain("group: 'command' as const");
      expect(content).toContain('void onSubmitCommandRef.current(item.command)');
    });

    it('starts the plan command in the input so the user can supply a goal', () => {
      expect(content).toContain("if (item.id === 'plan-cmd')");
      expect(content).toContain('onSetInput(item.command)');
    });

    it('defines help-cmd with /help command', () => {
      expect(content).toContain("command: '/help'");
    });

    it('defines compact-cmd with /compact command', () => {
      expect(content).toContain("command: '/compact'");
    });
  });

  describe('session targets', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAppCommandPalette.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('defines new-session entry that calls onClearSession', () => {
      expect(content).toContain("id: 'new-session'");
      expect(content).toContain("label: 'New Session'");
      expect(content).toContain('void onClearSession()');
    });

    it('defines open-transcript entry that calls onToggleTranscript', () => {
      expect(content).toContain("id: 'open-transcript'");
      expect(content).toContain("label: 'Open Transcript'");
      expect(content).toContain('action: onToggleTranscript');
    });

    it('defines resume-latest entry that resumes the first session', () => {
      expect(content).toContain("id: 'resume-latest'");
      expect(content).toContain("label: 'Resume Latest Session'");
      expect(content).toContain('recentSessions[0]');
      expect(content).toContain('void onResumeSession(latest.id)');
    });

    it('maps session targets to group session', () => {
      expect(content).toContain("group: 'session' as const");
    });

    it('generates per-session resume entries from recentSessions', () => {
      expect(content).toContain('recentSessions.map((session)');
      expect(content).toContain('`resume-${session.id}`');
      expect(content).toContain('`Resume ${session.title}`');
      expect(content).toContain('void onResumeSession(session.id)');
    });
  });

  describe('agent targets', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAppCommandPalette.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('maps subagentSuggestions to agent entries with @ prefix', () => {
      expect(content).toContain('subagentSuggestions.map((agent)');
      expect(content).toContain('`agent-${agent.name}`');
      expect(content).toContain('`@${agent.name}`');
    });

    it('agent action calls onSetInput with @agent name and trailing space', () => {
      expect(content).toContain('onSetInput(`@${agent.name} `)');
    });

    it('uses default description when agent has no description', () => {
      expect(content).toContain("agent.description || 'Delegate a task'");
    });

    it('maps agent targets to group agent', () => {
      expect(content).toContain("group: 'agent' as const");
    });
  });

  describe('mode toggle entries', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAppCommandPalette.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('defines mode-normal entry', () => {
      expect(content).toContain("id: 'mode-normal'");
      expect(content).toContain("label: 'Normal Mode'");
      expect(content).toContain("onApplyExecutionMode('normal')");
    });

    it('defines mode-auto entry', () => {
      expect(content).toContain("id: 'mode-auto'");
      expect(content).toContain("label: 'Auto-Approve Mode'");
      expect(content).toContain("onApplyExecutionMode('auto-approve')");
    });

    it('defines mode-toggle entry with conditional logic', () => {
      expect(content).toContain("id: 'mode-toggle'");
      expect(content).toContain("label: 'Toggle Mode'");
      expect(content).toContain("executionMode === 'normal' ? 'auto-approve' : 'normal'");
    });

    it('maps mode entries to group setting', () => {
      expect(content).toContain("group: 'setting' as const");
    });
  });

  describe('group and entry structure', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAppCommandPalette.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('returns entries with all expected groups', () => {
      expect(content).toContain("'screen' as const");
      expect(content).toContain("'command' as const");
      expect(content).toContain("'session' as const");
      expect(content).toContain("'agent' as const");
      expect(content).toContain("'setting' as const");
    });

    it('all mapped entries include id, label, description, group, and action', () => {
      expect(content).toContain('id: item.id');
      expect(content).toContain('label: item.label');
      expect(content).toContain('description: item.description');
      expect(content).toContain('group:');
      expect(content).toContain('action:');
    });

    it('final return combines all target arrays', () => {
      expect(content).toContain('...screenTargets.map(');
      expect(content).toContain('...commandTargets.map(');
      expect(content).toContain('...sessionTargets.map(');
      expect(content).toContain('...agentTargets.map(');
    });
  });
});
