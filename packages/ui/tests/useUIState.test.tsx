import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('useUIState hook', () => {
  describe('hook file exists and exports', () => {
    it('exports useUIState function', async () => {
      const { useUIState } = await import('../src/ui/hooks/useState/useUIState.js');
      expect(typeof useUIState).toBe('function');
    });
  });

  describe('source code structure', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useState/useUIState.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    // --- Imports ---

    it('imports useState from react', () => {
      expect(content).toContain('useState');
    });

    it('imports useRef from react', () => {
      expect(content).toContain('useRef');
    });

    it('exports useUIState function', () => {
      expect(content).toContain('export function useUIState()');
    });

    it('useUIState takes no arguments', () => {
      expect(content).toContain('export function useUIState()');
    });

    // --- Types ---

    it('exports ScreenType type', () => {
      expect(content).toContain('export type ScreenType');
    });

    it('ScreenType includes chat', () => {
      expect(content).toContain("'chat'");
    });

    it('ScreenType includes transcript', () => {
      expect(content).toContain("'transcript'");
    });

    it('exports AgentWizardState interface', () => {
      expect(content).toContain('export interface AgentWizardState');
    });

    it('AgentWizardState has step field with wizard steps', () => {
      expect(content).toContain("'name'");
      expect(content).toContain("'description'");
      expect(content).toContain("'scope'");
      expect(content).toContain("'tools'");
      expect(content).toContain("'maxTurns'");
      expect(content).not.toContain("'visible'");
    });

    it('exports PendingQuestionState interface', () => {
      expect(content).toContain('export interface PendingQuestionState');
    });

    it('PendingQuestionState has question and options fields', () => {
      expect(content).toContain('question: string');
      expect(content).toContain('options:');
    });

    it('PendingQuestionState has resolve field', () => {
      expect(content).toContain('resolve: (value: string | null) => void');
    });

    it('re-exports CommandItem type from CommandPalette', () => {
      expect(content).toContain('export type { CommandItem }');
    });

    it('exports UIStateResult interface', () => {
      expect(content).toContain('export interface UIStateResult');
    });

    // --- Input state ---

    it('creates input state with empty string default', () => {
      expect(content).toContain('const [input, setInput] = useState');
      expect(content).toContain("useState('')");
    });

    it('creates inputBlockedRef with boolean false default', () => {
      expect(content).toContain('inputBlockedRef');
      expect(content).toContain('useRef(false)');
    });

    it('creates inputBlockTimeoutRef with null default', () => {
      expect(content).toContain('inputBlockTimeoutRef');
      expect(content).toContain('useRef<ReturnType<typeof setTimeout> | null>(null)');
    });

    // --- Navigation ---

    it('creates activeScreen state with chat default', () => {
      expect(content).toContain('const [activeScreen, setActiveScreen] = useState<ScreenType>');
      expect(content).toContain("'chat'");
    });

    // --- Suggestions ---

    it('creates selectedSuggestionIndex state with 0 default', () => {
      expect(content).toContain(
        'const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)'
      );
    });

    // --- Transcript ---

    it('creates showAllInTranscript state with false default', () => {
      expect(content).toContain(
        'const [showAllInTranscript, setShowAllInTranscript] = useState(false)'
      );
    });

    // --- Command palette ---

    it('creates commandPaletteItems state with empty array default', () => {
      expect(content).toContain(
        'const [commandPaletteItems, setCommandPaletteItems] = useState<CommandItem[]>([])'
      );
    });

    // --- Agent wizard ---

    it('creates agentWizard state with null default', () => {
      expect(content).toContain(
        'const [agentWizard, setAgentWizard] = useState<AgentWizardState | null>(null)'
      );
    });

    // --- Provider connection ---

    it('creates pendingConnectProvider state with null default', () => {
      expect(content).toContain(
        'const [pendingConnectProvider, setPendingConnectProvider] = useState<string | null>(null)'
      );
    });

    // --- Pending question ---

    it('creates pendingQuestion state with null default', () => {
      expect(content).toContain(
        'const [pendingQuestion, setPendingQuestion] = useState<PendingQuestionState | null>(null)'
      );
    });

    // --- Message queue ---

    it('creates queuedMessages state with empty array default', () => {
      expect(content).toContain(
        'const [queuedMessages, setQueuedMessages] = useState<string[]>([])'
      );
    });

    // --- Return values ---

    it('returns input and setInput', () => {
      expect(content).toContain('input,');
      expect(content).toContain('setInput,');
    });

    it('returns inputBlockedRef', () => {
      expect(content).toContain('inputBlockedRef,');
    });

    it('returns inputBlockTimeoutRef', () => {
      expect(content).toContain('inputBlockTimeoutRef,');
    });

    it('returns activeScreen and setActiveScreen', () => {
      expect(content).toContain('activeScreen,');
      expect(content).toContain('setActiveScreen,');
    });

    it('returns selectedSuggestionIndex and setSelectedSuggestionIndex', () => {
      expect(content).toContain('selectedSuggestionIndex,');
      expect(content).toContain('setSelectedSuggestionIndex,');
    });

    it('returns showAllInTranscript and setShowAllInTranscript', () => {
      expect(content).toContain('showAllInTranscript,');
      expect(content).toContain('setShowAllInTranscript,');
    });

    it('returns commandPaletteItems and setCommandPaletteItems', () => {
      expect(content).toContain('commandPaletteItems,');
      expect(content).toContain('setCommandPaletteItems,');
    });

    it('returns agentWizard and setAgentWizard', () => {
      expect(content).toContain('agentWizard,');
      expect(content).toContain('setAgentWizard,');
    });

    it('returns pendingConnectProvider and setPendingConnectProvider', () => {
      expect(content).toContain('pendingConnectProvider,');
      expect(content).toContain('setPendingConnectProvider,');
    });

    it('returns pendingQuestion and setPendingQuestion', () => {
      expect(content).toContain('pendingQuestion,');
      expect(content).toContain('setPendingQuestion,');
    });

    it('returns queuedMessages and setQueuedMessages', () => {
      expect(content).toContain('queuedMessages,');
      expect(content).toContain('setQueuedMessages,');
    });

    // --- Return type completeness ---

    it('UIStateResult has input field with correct type', () => {
      expect(content).toContain('input: string');
    });

    it('UIStateResult has setInput field with correct type', () => {
      expect(content).toContain('setInput: React.Dispatch<React.SetStateAction<string>>');
    });

    it('UIStateResult has inputBlockedRef field with correct type', () => {
      expect(content).toContain('inputBlockedRef: React.MutableRefObject<boolean>');
    });

    it('UIStateResult has inputBlockTimeoutRef field with correct type', () => {
      expect(content).toContain(
        'inputBlockTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>'
      );
    });

    it('UIStateResult has activeScreen field with ScreenType', () => {
      expect(content).toContain('activeScreen: ScreenType');
    });

    it('UIStateResult has setActiveScreen field', () => {
      expect(content).toContain(
        'setActiveScreen: React.Dispatch<React.SetStateAction<ScreenType>>'
      );
    });

    it('UIStateResult has selectedSuggestionIndex field', () => {
      expect(content).toContain('selectedSuggestionIndex: number');
    });

    it('UIStateResult has showAllInTranscript field', () => {
      expect(content).toContain('showAllInTranscript: boolean');
    });

    it('UIStateResult has commandPaletteItems field', () => {
      expect(content).toContain('commandPaletteItems: CommandItem[]');
    });

    it('UIStateResult has agentWizard field', () => {
      expect(content).toContain('agentWizard: AgentWizardState | null');
    });

    it('UIStateResult has pendingConnectProvider field', () => {
      expect(content).toContain('pendingConnectProvider: string | null');
    });

    it('UIStateResult has pendingQuestion field', () => {
      expect(content).toContain('pendingQuestion: PendingQuestionState | null');
    });

    it('UIStateResult has queuedMessages field', () => {
      expect(content).toContain('queuedMessages: string[]');
    });

    // --- No external dependencies (except CommandPalette re-export) ---

    it('imports from CommandPalette for type re-export', () => {
      expect(content).toContain('CommandPalette');
    });

    it('does not use useCallback (pure state, no callbacks needed)', () => {
      expect(content).not.toContain('useCallback');
    });

    it('does not use useEffect (pure state, no side effects)', () => {
      expect(content).not.toContain('useEffect');
    });
  });

  describe('App.tsx post-integration state', () => {
    const appPath = join(__dirname, '../src/ui/App.tsx');
    let content: string;

    beforeEach(() => {
      content = readFileSync(appPath, 'utf-8');
    });

    it('hook file is importable', async () => {
      const mod = await import('../src/ui/hooks/useState/useUIState.js');
      expect(typeof mod.useUIState).toBe('function');
    });

    // After integration, App.tsx uses useUIState() instead of inline state.
    it('App.tsx imports useUIState', () => {
      expect(content).toContain('useUIState');
    });

    it('App.tsx destructures input from useUIState', () => {
      expect(content).toContain('input,');
      expect(content).toContain('setInput,');
    });

    it('App.tsx destructures activeScreen from useUIState', () => {
      expect(content).toContain('activeScreen,');
      expect(content).toContain('setActiveScreen,');
    });

    it('App.tsx destructures pendingQuestion from useUIState', () => {
      expect(content).toContain('pendingQuestion,');
      expect(content).toContain('setPendingQuestion,');
    });

    it('App.tsx destructures queuedMessages from useUIState', () => {
      expect(content).toContain('queuedMessages,');
      expect(content).toContain('setQueuedMessages,');
    });

    it('App.tsx no longer has inline input useState', () => {
      expect(content).not.toContain("const [input, setInput] = useState('')");
    });

    it('App.tsx no longer has inline activeScreen useState', () => {
      expect(content).not.toContain(
        "const [activeScreen, setActiveScreen] = useState<ScreenType>('chat')"
      );
    });

    it('App.tsx no longer has inline inputBlockedRef', () => {
      expect(content).not.toContain('const inputBlockedRef = useRef(false)');
    });

    it('App.tsx no longer has inline inputBlockTimeoutRef', () => {
      expect(content).not.toContain(
        'const inputBlockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)'
      );
    });
  });
});
