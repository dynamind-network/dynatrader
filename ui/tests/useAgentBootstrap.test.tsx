import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('useAgentBootstrap hook', () => {
  describe('hook file exists and exports', () => {
    it('exports useAgentBootstrap function', async () => {
      const { useAgentBootstrap } = await import('../src/ui/hooks/useAgentBootstrap.js');
      expect(typeof useAgentBootstrap).toBe('function');
    });

    it('exports AgentBootstrapResult interface via return type', async () => {
      const { useAgentBootstrap } = await import('../src/ui/hooks/useAgentBootstrap.js');
      expect(useAgentBootstrap).toBeDefined();
    });
  });

  describe('source code structure', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useAgentBootstrap.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('imports AgentLoop from index', () => {
      expect(content).toContain('AgentLoop');
    });

    it('does not import createDefaultToolRegistry', () => {
      expect(content).not.toContain('createDefaultToolRegistry');
    });

    it('imports findProviderForModel', () => {
      expect(content).toContain('findProviderForModel');
    });

    it('imports SubagentRegistry', () => {
      expect(content).toContain('SubagentRegistry');
    });

    it('does not import registerSpawnAgentTools', () => {
      expect(content).not.toContain('registerSpawnAgentTools');
    });

    it('does not import default subagents', () => {
      expect(content).not.toContain('defaultSubagents');
    });

    it('does not import SkillManager', () => {
      expect(content).not.toContain('SkillManager');
    });

    it('does not import SkillTool', () => {
      expect(content).not.toContain('SkillTool');
    });

    it('imports getErrorMessage', () => {
      expect(content).toContain('getErrorMessage');
    });

    it('uses useState for agentLoop state', () => {
      expect(content).toContain('useState<AgentLoop | null>(null)');
    });

    it('uses useState for subagentRegistry state', () => {
      expect(content).toContain('useState<SubagentRegistry | null>(null)');
    });

    it('uses useState for subagentSuggestions state', () => {
      expect(content).toContain('useState<');
      expect(content).toContain('subagentSuggestions');
    });

    it('uses useState for isBootstrapping state', () => {
      expect(content).toContain('useState(false)');
      expect(content).toContain('isBootstrapping');
    });

    it('uses useCallback for bootstrap function', () => {
      expect(content).toContain('useCallback(');
    });

    it('checks for empty API keys', () => {
      expect(content).toContain('hasAnyKey');
      expect(content).toContain('value.trim().length > 0');
    });

    it('returns null when no keys', () => {
      expect(content).toContain('setAgentLoop(null)');
      expect(content).toContain('setSubagentRegistry(null)');
      expect(content).toContain('setSubagentSuggestions([])');
    });

    it('stops bootstrap when no model is selected', () => {
      expect(content).toContain(
        'No model selected. Use /model to choose a model before starting the agent.'
      );
      expect(content).toContain('const selectedModel = currentModelRef.current?.trim()');
      expect(content).toContain('if (!selectedModel) {');
    });

    it('validates current model provider has key', () => {
      expect(content).toContain('findProviderForModel(currentModelRef.current)');
    });

    it('emits text event when provider key is missing', () => {
      expect(content).toContain("type: 'text'");
      expect(content).toContain('requires');
      expect(content).toContain('API key');
    });

    it('does not create a tool registry here', () => {
      expect(content).not.toContain('createDefaultToolRegistry(configRef.current.cwd)');
    });

    it('does not initialize SkillManager here', () => {
      expect(content).not.toContain('new SkillManager()');
      expect(content).not.toContain('discoverAndLoad()');
    });

    it('does not register SkillTool here', () => {
      expect(content).not.toContain('new SkillTool(skillManager)');
    });

    it('creates SubagentRegistry with project and global dirs', () => {
      expect(content).toContain('projectDir');
      expect(content).toContain('globalDir');
      expect(content).toContain(".dynamind', 'agents')");
    });

    it('initializes subagent registry', () => {
      expect(content).toContain('registry.initialize()');
    });

    it('does not register bundled subagents', () => {
      expect(content).not.toContain('registry.register(def)');
      expect(content).not.toContain('defaultSubagents');
    });

    it('generates subagent suggestions from visible agents', () => {
      expect(content).toContain('registry.getVisible()');
      expect(content).toContain('suggestionItems');
    });

    it('does not register spawn agent tools here', () => {
      expect(content).not.toContain('registerSpawnAgentTools');
    });

    it('creates AgentLoop with correct config', () => {
      expect(content).toContain('new AgentLoop(');
      expect(content).toContain('maxTokens: 4096');
      expect(content).toContain('configRef.current.maxTurns');
    });

    it('hydrates conversation if provided', () => {
      expect(content).toContain('conversationToHydrate');
      expect(content).toContain('loop.addMessage(message)');
    });

    it('sets execution mode', () => {
      expect(content).toContain('setExecutionMode');
      expect(content).toContain('executionModeOverride ?? executionMode');
    });

    it('handles errors gracefully', () => {
      expect(content).toContain('catch (error)');
      expect(content).toContain('getErrorMessage(error)');
      expect(content).toContain("type: 'error'");
      expect(content).toContain('Failed to initialize AI agent');
    });

    it('resets state in finally block', () => {
      expect(content).toContain('finally');
      expect(content).toContain('setIsBootstrapping(false)');
    });

    it('sets isBootstrapping to true in try block', () => {
      expect(content).toContain('setIsBootstrapping(true)');
    });

    it('returns all expected values', () => {
      expect(content).toContain(
        'return { agentLoop, subagentRegistry, subagentSuggestions, bootstrap, isBootstrapping }'
      );
    });

    it('has correct dependency array for useCallback', () => {
      // Uses refs pattern - empty dependency array
      expect(content).toContain('[] // Empty deps');
      expect(content).toContain('configRef');
      expect(content).toContain('currentModelRef');
      expect(content).toContain('executionModeRef');
      expect(content).toContain('onEventRef');
      expect(content).toContain('onApprovalRequiredRef');
      expect(content).toContain('onTimelineEventRef');
    });
  });

  describe('App.tsx integration', () => {
    const appPath = join(__dirname, '../src/ui/App.tsx');
    let content: string;

    beforeEach(() => {
      content = readFileSync(appPath, 'utf-8');
    });

    it('imports useAgentBootstrap', () => {
      expect(content).toContain('useAgentBootstrap');
    });
  });
});
