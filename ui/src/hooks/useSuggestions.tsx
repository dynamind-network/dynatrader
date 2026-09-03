import { useMemo, useCallback } from 'react';
import { getCommandRegistry, registerBuiltinCommands } from '../commands/index.js';
import type {
  SuggestionItem,
  CommandSuggestion,
  RecentSuggestion,
} from '../ui/common/CommandInput.js';

interface UseSuggestionsOptions {
  input: string;
  agentSuggestions?: Array<{ name: string; description: string }>;
}

let registryInitialized = false;

function ensureRegistryLoaded() {
  if (!registryInitialized) {
    registerBuiltinCommands();
    registryInitialized = true;
  }
}

export function useSuggestions({
  input,
  agentSuggestions: providedAgentSuggestions = [],
}: UseSuggestionsOptions) {
  const commandSuggestions = useMemo<CommandSuggestion[]>(() => {
    ensureRegistryLoaded();
    const registry = getCommandRegistry();
    return registry.getDescriptions().map((cmd) => ({
      type: 'command' as const,
      name: cmd.name,
      shortcut: `/${cmd.name}`,
      description: cmd.description,
      argumentHint: cmd.argumentHint,
    }));
  }, []);

  const agentSuggestions = useMemo<RecentSuggestion[]>(
    () =>
      providedAgentSuggestions.map((a) => ({
        type: 'recent' as const,
        name: a.name,
        description: a.description,
      })),
    [providedAgentSuggestions]
  );

  const currentSuggestions = useMemo(() => {
    if (input.startsWith('/')) {
      return commandSuggestions.filter(
        (c) => (c.shortcut?.startsWith(input) && c.shortcut !== input) || input === '/'
      );
    }
    if (input.startsWith('@')) {
      return agentSuggestions.filter(
        (a) => a.name.startsWith(input.slice(1)) && a.name !== input.slice(1)
      );
    }
    return [];
  }, [input, commandSuggestions, agentSuggestions]);

  const hasSuggestions = currentSuggestions.length > 0;
  const isSlashMode = input.startsWith('/');
  const isAtMode = input.startsWith('@');

  const selectSuggestion = useCallback(
    (index: number, setInput: (value: string) => void) => {
      const suggestion = currentSuggestions[index];
      if (suggestion) {
        if (suggestion.type === 'command') {
          setInput(suggestion.shortcut + ' ');
        } else {
          setInput('@' + suggestion.name + ' ');
        }
      }
    },
    [currentSuggestions]
  );

  return {
    commandSuggestions,
    agentSuggestions,
    currentSuggestions,
    hasSuggestions,
    isSlashMode,
    isAtMode,
    selectSuggestion,
  };
}
