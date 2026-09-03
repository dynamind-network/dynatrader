import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('useInputHandler hook', () => {
  describe('hook file exists and exports', () => {
    it('exports useInputHandler function', async () => {
      const { useInputHandler } = await import('../src/ui/hooks/useInputHandler.js');
      expect(typeof useInputHandler).toBe('function');
    });

    it('exports InputHandlerResult interface via return type', async () => {
      const { useInputHandler } = await import('../src/ui/hooks/useInputHandler.js');
      expect(useInputHandler).toBeDefined();
    });
  });

  describe('source code structure', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('imports useCallback from react', () => {
      expect(content).toContain('useCallback');
    });

    it('imports useRef from react', () => {
      expect(content).toContain('useRef');
    });

    it('imports QuestionPrompt type', () => {
      expect(content).toContain('QuestionPrompt');
    });

    it('imports QuestionOption type', () => {
      expect(content).toContain('QuestionOption');
    });

    it('defines PendingQuestionState interface', () => {
      expect(content).toContain('PendingQuestionState');
    });

    it('defines AgentWizardState interface', () => {
      expect(content).toContain('AgentWizardState');
    });

    it('defines InputHandlerResult interface', () => {
      expect(content).toContain('InputHandlerResult');
    });

    it('exports handleSubmit in result', () => {
      expect(content).toContain('handleSubmit');
    });

    it('exports resolvePendingApproval in result', () => {
      expect(content).toContain('resolvePendingApproval');
    });

    it('exports resolvePendingQuestion in result', () => {
      expect(content).toContain('resolvePendingQuestion');
    });

    it('exports askQuestion in result', () => {
      expect(content).toContain('askQuestion');
    });

    it('uses useCallback for handleSubmit', () => {
      expect(content).toMatch(/const handleSubmit = useCallback\(/);
    });

    it('uses useCallback for resolvePendingApproval', () => {
      expect(content).toMatch(/const resolvePendingApproval = useCallback\(/);
    });

    it('uses useCallback for resolvePendingQuestion', () => {
      expect(content).toMatch(/const resolvePendingQuestion = useCallback\(/);
    });

    it('uses useCallback for askQuestion', () => {
      expect(content).toMatch(/const askQuestion = useCallback\(/);
    });
  });

  describe('handleSubmit logic - empty text', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('trims input text', () => {
      expect(content).toContain('text.trim()');
    });

    it('returns early for empty text without pending question', () => {
      expect(content).toMatch(/if \(!trimmedText\)/);
    });

    it('handles empty text with pending question and default value', () => {
      expect(content).toContain('pending.defaultValue');
    });
  });

  describe('handleSubmit logic - pending question', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('handles /cancel for pending question', () => {
      expect(content).toContain("normalized === '/cancel'");
    });

    it('handles numeric choice for pending question', () => {
      expect(content).toContain('Number.parseInt(trimmedText, 10)');
      expect(content).toContain('numericChoice >= 1');
    });

    it('handles label/value match for pending question', () => {
      expect(content).toContain('option.value.toLowerCase() === normalized');
      expect(content).toContain('option.label.toLowerCase() === normalized');
    });

    it('shows error message for unmatched pending question input', () => {
      expect(content).toContain('Choose one of the numbered options');
    });
  });

  describe('handleSubmit logic - pending approval', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('handles y/yes for approval', () => {
      expect(content).toContain("normalized === 'y'");
      expect(content).toContain("normalized === 'yes'");
    });

    it('handles n/no for denial', () => {
      expect(content).toContain("normalized === 'n'");
      expect(content).toContain("normalized === 'no'");
    });

    it('shows error message for invalid approval input', () => {
      expect(content).toContain('Enter "y" to approve or "n" to deny');
    });
  });

  describe('handleSubmit logic - agent wizard', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('handles /cancel for agent wizard', () => {
      expect(content).toContain("trimmedText === '/cancel'");
      expect(content).toContain('Cancelled workspace agent creation');
    });

    it('handles name step', () => {
      expect(content).toContain("case 'name':");
      expect(content).toContain("step: 'description'");
    });

    it('handles description step', () => {
      expect(content).toContain("case 'description':");
      expect(content).toContain("step: 'scope'");
    });

    it('handles scope step with validation', () => {
      expect(content).toContain("case 'scope':");
      expect(content).toContain("normalized !== 'project' && normalized !== 'global'");
    });

    it('handles tools step with all option', () => {
      expect(content).toContain("case 'tools':");
      expect(content).toContain("trimmedText.toLowerCase() === 'all'");
    });

    it('handles maxTurns step with validation', () => {
      expect(content).toContain("case 'maxTurns':");
      expect(content).toContain('!Number.isFinite(parsedTurns)');
    });

    it('auto-completes agent creation after maxTurns', () => {
      expect(content).not.toContain("case 'visible':");
      expect(content).toContain('visible: true');
    });
  });

  describe('handleSubmit logic - connect provider', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('handles /connect command with regex', () => {
      expect(content).toContain('/^\\/connect\\s+(\\S+)$/i');
    });

    it('sets pending connect provider', () => {
      expect(content).toContain('onSetPendingConnectProvider(provider)');
    });
  });

  describe('handleSubmit logic - suggestions', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('selects suggestion when suggestions are visible', () => {
      expect(content).toContain('selectSuggestion(selectedSuggestionIndex, onSetInput)');
    });

    it('checks hasSuggestions and currentSuggestions length', () => {
      expect(content).toContain('hasSuggestions');
      expect(content).toContain('currentSuggestions.length > 0');
    });
  });

  describe('handleSubmit logic - normal message submission', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('adds user message to chat', () => {
      expect(content).toContain("role: 'user'");
      expect(content).toContain('content: trimmedText');
    });

    it('checks for API key configuration', () => {
      expect(content).toContain('hasAnyKey');
      expect(content).toContain('No API key configured');
    });

    it('queues message if processing', () => {
      expect(content).toContain('toolState.state.isProcessing');
      expect(content).toContain('onSetQueuedMessages');
    });

    it('submits command if not processing', () => {
      expect(content).toContain('submitCommand(trimmedText)');
    });

    it('clears input after submission', () => {
      expect(content).toContain("onSetInput('')");
    });

    it('resets suggestion index after submission', () => {
      expect(content).toContain('onSetSelectedSuggestionIndex(0)');
    });
  });

  describe('resolvePendingApproval', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('returns false when no pending approval', () => {
      expect(content).toContain('if (!pendingApproval)');
      expect(content).toContain('return false');
    });

    it('calls resolve with approved value', () => {
      expect(content).toContain('pendingApproval.resolve(approved)');
    });

    it('removes pending approval from toolState', () => {
      expect(content).toContain('toolState.removePendingApproval');
    });

    it('finishes tool in history when denied', () => {
      expect(content).toContain('toolState.finishToolInHistory');
      expect(content).toContain('if (!approved)');
    });

    it('clears input after resolution', () => {
      expect(content).toContain("onSetInput('')");
    });
  });

  describe('resolvePendingQuestion', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('returns false when no pending question', () => {
      expect(content).toContain('if (!pendingQuestion)');
    });

    it('resolves with selected value', () => {
      expect(content).toContain('pendingQuestion.resolve(selectedValue)');
    });

    it('clears pending question state', () => {
      expect(content).toContain('onSetPendingQuestion(null)');
    });

    it('clears input after resolution', () => {
      expect(content).toContain("onSetInput('')");
    });
  });

  describe('askQuestion', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useInputHandler.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('returns null if question already pending', () => {
      expect(content).toContain('if (pendingQuestionRef.current)');
      expect(content).toContain('return null');
    });

    it('returns a Promise', () => {
      expect(content).toContain('new Promise<string | null>');
    });

    it('sets pending question with prompt data', () => {
      expect(content).toContain('prompt.question');
      expect(content).toContain('prompt.options');
      expect(content).toContain('prompt.defaultValue');
    });
  });

  describe('App.tsx integration', () => {
    const appPath = join(__dirname, '../src/ui/App.tsx');
    let content: string;

    beforeEach(() => {
      content = readFileSync(appPath, 'utf-8');
    });

    it('imports useInputHandler', () => {
      expect(content).toContain('useInputHandler');
    });

    it('calls useInputHandler hook', () => {
      expect(content).toMatch(/useInputHandler\(/);
    });

    it('uses handleSubmit from hook result', () => {
      expect(content).toMatch(/handleSubmit/);
    });
  });
});
