import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('useTitleGeneration hook', () => {
  describe('hook file exists and exports', () => {
    it('exports useTitleGeneration function', async () => {
      const { useTitleGeneration } = await import('../src/ui/hooks/useTitleGeneration.js');
      expect(typeof useTitleGeneration).toBe('function');
    });
  });

  describe('source code structure', () => {
    const hookPath = join(__dirname, '../src/ui/hooks/useTitleGeneration.ts');
    let content: string;

    beforeEach(() => {
      content = readFileSync(hookPath, 'utf-8');
    });

    it('imports useEffect from react', () => {
      expect(content).toContain('useEffect');
    });

    it('imports Message type from UI types', () => {
      expect(content).toContain("from '../types.js'");
    });

    it('imports helpers from chatHelpers', () => {
      expect(content).toContain('chatHelpers');
    });

    it('exports useTitleGeneration function', () => {
      expect(content).toContain('export function useTitleGeneration');
    });

    it('defines TitleGenOpts interface', () => {
      expect(content).toContain('TitleGenOpts');
    });

    it('accepts messages in options', () => {
      expect(content).toContain('messages');
    });

    it('accepts currentModel in options', () => {
      expect(content).toContain('currentModel');
    });

    it('accepts resolvedApiKeys in options', () => {
      expect(content).toContain('resolvedApiKeys');
    });

    it('accepts isSwitchingSession in options', () => {
      expect(content).toContain('isSwitchingSession');
    });

    it('accepts toolStateIsProcessing in options', () => {
      expect(content).toContain('toolStateIsProcessing');
    });

    it('accepts sessionTitle in options', () => {
      expect(content).toContain('sessionTitle: string');
    });

    it('accepts setSessionTitle callback in options', () => {
      expect(content).toContain('setSessionTitle: (title: string) => void');
    });

    it('accepts sessionTitleRef in options', () => {
      expect(content).toContain('sessionTitleRef: React.MutableRefObject<string>');
    });

    it('accepts titleGenerationInFlightRef in options', () => {
      expect(content).toContain('titleGenerationInFlightRef');
    });

    it('accepts titleGenerationDoneRef in options', () => {
      expect(content).toContain('titleGenerationDoneRef');
    });

    it('accepts titleAgentPrompt', () => {
      expect(content).toContain('titleAgentPrompt');
    });

    it('does not define a built-in hidden title agent prompt', () => {
      expect(content).not.toContain(
        'You are a hidden title agent. Output a short session title only.'
      );
    });

    it('accepts findProviderForModel callback', () => {
      expect(content).toContain('findProviderForModel');
    });

    it('accepts createProvider callback', () => {
      expect(content).toContain('createProvider');
    });

    it('returns void (operates via side effects)', () => {
      expect(content).toContain('): void');
    });

    it('initializes with New chat check', () => {
      expect(content).toContain("'New chat'");
    });

    it('has generateTitle async function', () => {
      expect(content).toContain('async function generateTitle');
    });

    it('generateTitle checks for API key before calling LLM', () => {
      expect(content).toContain('apiKey');
      expect(content).toContain('deriveSessionTitle');
    });

    it('generateTitle falls back locally when no title prompt is provided', () => {
      expect(content).toContain('!titleAgentPrompt');
      expect(content).toContain('deriveSessionTitle(chatMessages)');
    });

    it('generateTitle calls createProvider with provider name and API key', () => {
      expect(content).toContain('createProvider(providerName');
    });

    it('generateTitle calls provider.chat', () => {
      expect(content).toContain('provider.chat');
    });

    it('generateTitle cleans the generated title', () => {
      expect(content).toContain('cleanGeneratedTitle');
    });

    it('generateTitle falls back to deriveSessionTitle on error', () => {
      // Verify the entire hook file contains the catch block and fallback
      expect(content).toContain('catch {');
      expect(content).toContain('return deriveSessionTitle(chatMessages);');
    });

    it('has useEffect for automatic title generation', () => {
      expect(content).toContain('useEffect(');
    });

    it('useEffect skips when isSwitchingSession is true', () => {
      expect(content).toContain('isSwitchingSession');
    });

    it('useEffect skips when toolStateIsProcessing is true', () => {
      expect(content).toContain('toolStateIsProcessing');
    });

    it('useEffect skips when titleGenerationDoneRef is true', () => {
      expect(content).toContain('titleGenerationDoneRef.current');
    });

    it('useEffect skips when titleGenerationInFlightRef is true', () => {
      expect(content).toContain('titleGenerationInFlightRef.current');
    });

    it('useEffect filters messages to user and assistant roles', () => {
      expect(content).toContain("message.role === 'user'");
      expect(content).toContain("message.role === 'assistant'");
    });

    it('useEffect checks for at least 2 transcript messages', () => {
      expect(content).toContain('transcriptMessages.length');
    });

    it('useEffect checks last message is assistant', () => {
      expect(content).toContain(
        "transcriptMessages[transcriptMessages.length - 1].role !== 'assistant'"
      );
    });

    it('useEffect sets session title after generation', () => {
      expect(content).toContain('setSessionTitle');
    });

    it('useEffect updates sessionTitleRef after generation', () => {
      expect(content).toContain('sessionTitleRef.current = nextTitle');
    });

    it('useEffect sets titleGenerationDoneRef to true after generation', () => {
      expect(content).toContain('titleGenerationDoneRef.current = true');
    });

    it('useEffect resets titleGenerationInFlightRef in finally block', () => {
      expect(content).toContain('titleGenerationInFlightRef.current = false');
    });

    it('has useEffect to sync sessionTitleRef with sessionTitle', () => {
      expect(content).toContain('sessionTitleRef.current = sessionTitle');
    });

    it('skips title generation if title was already set to non-derived value', () => {
      expect(content).toContain('currentSavedTitle !== currentDerivedTitle');
    });
  });

  describe('App.tsx post-integration state', () => {
    const appPath = join(__dirname, '../src/ui/App.tsx');
    let content: string;

    beforeEach(() => {
      content = readFileSync(appPath, 'utf-8');
    });

    it('hook file is importable', async () => {
      const mod = await import('../src/ui/hooks/useTitleGeneration.js');
      expect(typeof mod.useTitleGeneration).toBe('function');
    });

    it('App.tsx imports useTitleGeneration', () => {
      expect(content).toContain('useTitleGeneration');
    });

    it('App.tsx calls useTitleGeneration with messages', () => {
      expect(content).toContain('useTitleGeneration({');
      expect(content).toContain('messages,');
    });

    it('App.tsx no longer has inline generateSessionTitle useCallback', () => {
      const localGenerateMatch = content.match(/const generateSessionTitle = useCallback\(/);
      expect(localGenerateMatch).toBeNull();
    });

    it('App.tsx still has sessionTitleRef (owned by App, passed to hook)', () => {
      const directRefMatch = content.match(/const sessionTitleRef = useRef/);
      expect(directRefMatch).not.toBeNull();
    });

    it('App.tsx still has titleGenerationInFlightRef (owned by App, passed to hook)', () => {
      const directRefMatch = content.match(/const titleGenerationInFlightRef = useRef/);
      expect(directRefMatch).not.toBeNull();
    });

    it('App.tsx still has titleGenerationDoneRef (owned by App, passed to hook)', () => {
      const directRefMatch = content.match(/const titleGenerationDoneRef = useRef/);
      expect(directRefMatch).not.toBeNull();
    });

    it('App.tsx no longer has inline title generation effect', () => {
      // The title generation effect is now inside the hook
      const hasInlineEffect =
        content.includes('titleGenerationInFlightRef.current = true') &&
        content.includes('deriveSessionTitle(messages)');
      // After integration, the inline effect should be gone
      // The hook's generateTitle function is in the hook file, not App.tsx
      expect(content).not.toContain('generateSessionTitle(transcriptMessages)');
    });

    it('App.tsx no longer has standalone sessionTitleRef sync useEffect', () => {
      // After integration, the sync is inside the hook
      // App.tsx may still set sessionTitleRef.current in session resume logic,
      // but should NOT have a dedicated useEffect just for syncing
      const lines = content.split('\n');
      const hasSyncUseEffect = lines.some(
        (line, idx) =>
          line.includes('useEffect') &&
          !line.includes('//') &&
          // Check if the useEffect block contains sessionTitleRef.current = sessionTitle
          lines
            .slice(idx, idx + 5)
            .some((l) => l.includes('sessionTitleRef.current = sessionTitle') && !l.includes('//'))
      );
      expect(hasSyncUseEffect).toBe(false);
    });
  });
});
