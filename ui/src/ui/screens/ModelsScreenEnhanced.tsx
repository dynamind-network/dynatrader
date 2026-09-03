import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';
import {
  listCatalogModels,
  detectLMStudioModels,
  type CatalogModel,
  type EffortLevel,
  EFFORT_LEVELS,
} from '../../index.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import { ListItem, ListContainer, Byline, KeyboardShortcutHint } from '../common/ListItem.js';
import { useSearchFilter } from '../hooks/useSearchFilter.js';

export type ModelsScreenPhase = 'models' | 'effort';

interface ModelsScreenProps {
  currentModel: string;
  apiKeys: Record<string, string>;
  onSelect: (modelId: string) => void;
  onConnectProvider?: (provider: string) => void;
  onEffortSelect?: (effort: EffortLevel) => void;
  currentEffort?: EffortLevel;
  onBack: () => void;
  selectedIndex: number;
  effortIndex?: number;
  phase?: ModelsScreenPhase;
  pendingModelId?: string | null;
  height?: number;
  width?: number;
  /** Called when model list is ready so parent can clamp selectedIndex */
  onModelsLoaded?: (models: CatalogModel[]) => void;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatContextWindow(contextWindow?: number): string | null {
  if (!contextWindow) return null;
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(1)}M`;
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}k`;
  return String(contextWindow);
}

function formatEffort(level: EffortLevel): string {
  if (level === 'none') return 'off';
  return level;
}

// ── Search helpers ──────────────────────────────────────────────────────────

function getSearchableText(model: CatalogModel): string {
  return [model.name, model.providerName, model.provider, model.id].join(' ');
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function ModelRow({
  model,
  isSelected,
  isCurrent,
  query,
}: {
  model: CatalogModel;
  isSelected: boolean;
  isCurrent: boolean;
  query: string;
}) {
  const ctx = formatContextWindow(model.contextWindow);
  const effort = model.supportsEffort ? 'reasoning' : null;
  const byline = [model.providerName, ctx, effort].filter(Boolean).join(` ${GLYPHS.separator} `);

  return (
    <ListItem
      isSelected={isSelected}
      isCurrent={isCurrent}
      isDisabled={!model.hasKey}
      label={model.name}
      byline={byline}
      highlightQuery={query}
    />
  );
}

function EffortRow({
  level,
  isSelected,
  isCurrent,
}: {
  level: EffortLevel;
  isSelected: boolean;
  isCurrent: boolean;
}) {
  return (
    <ListItem
      isSelected={isSelected}
      isCurrent={isCurrent}
      label={level}
      showIndicator={true}
    />
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function ModelsScreenEnhanced({
  currentModel,
  apiKeys,
  onSelect,
  onConnectProvider,
  currentEffort = 'none',
  onBack,
  selectedIndex,
  effortIndex = 0,
  phase = 'models',
  pendingModelId = null,
  height = 24,
  width = 80,
  onModelsLoaded,
}: ModelsScreenProps) {
  const [models, setModels] = useState<CatalogModel[]>(() => listCatalogModels(apiKeys));
  const [loading, setLoading] = useState(true);
  const [searchMode, setSearchMode] = useState(false);

  const {
    query,
    setQuery,
    filteredItems,
    isSearchActive,
    clearSearch,
    totalCount,
    filteredCount,
  } = useSearchFilter({
    items: models,
    getSearchableText,
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await detectLMStudioModels();
      } catch {
        // keep static catalog
      }
      if (!cancelled) {
        const next = listCatalogModels(apiKeys);
        setModels(next);
        setLoading(false);
        onModelsLoaded?.(next);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiKeys]);

  // Windowed list: keep selection visible
  const headerRows = 4;
  const footerRows = 2;
  const visibleRows = Math.max(4, height - headerRows - footerRows);

  const windowStart = useMemo(() => {
    if (filteredItems.length <= visibleRows) return 0;
    const mid = Math.floor(visibleRows / 2);
    let start = selectedIndex - mid;
    if (start < 0) start = 0;
    if (start + visibleRows > filteredItems.length)
      start = Math.max(0, filteredItems.length - visibleRows);
    return start;
  }, [filteredItems.length, selectedIndex, visibleRows]);

  const windowEnd = Math.min(filteredItems.length, windowStart + visibleRows);

  // Build visible rows with provider group headers
  const rows: Array<
    | { kind: 'header'; provider: string; providerName: string; hasAnyKey: boolean }
    | { kind: 'model'; model: CatalogModel; globalIndex: number }
  > = [];

  let lastProvider = '';
  for (let i = windowStart; i < windowEnd; i++) {
    const model = filteredItems[i]!;
    if (model.provider !== lastProvider) {
      const hasAnyKey = filteredItems.some((m) => m.provider === model.provider && m.hasKey);
      rows.push({
        kind: 'header',
        provider: model.provider,
        providerName: model.providerName,
        hasAnyKey,
      });
      lastProvider = model.provider;
    }
    rows.push({ kind: 'model', model, globalIndex: i });
  }

  const selected = filteredItems[selectedIndex] ?? null;

  // Handle keyboard input for search mode
  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          return?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          backspace?: boolean;
          tab?: boolean;
        }
      ) => {
        if (phase !== 'models') return;

        if (key.escape) {
          if (searchMode) {
            setSearchMode(false);
            clearSearch();
          } else {
            onBack();
          }
          return;
        }

        if (key.tab) {
          setSearchMode((prev) => !prev);
          if (searchMode) {
            clearSearch();
          }
          return;
        }

        if (searchMode) {
          if (key.return) {
            // Select the current model
            if (selected && selected.hasKey) {
              onSelect(selected.id);
            } else if (selected && !selected.hasKey && onConnectProvider) {
              onConnectProvider(selected.provider);
            }
            return;
          }

          if (key.upArrow) {
            setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredItems.length - 1));
            return;
          }

          if (key.downArrow) {
            setSelectedIndex((prev) => (prev < filteredItems.length - 1 ? prev + 1 : 0));
            return;
          }

          if (key.backspace) {
            setQuery(query.slice(0, -1));
            setSelectedIndex(() => 0);
            return;
          }

          if (input) {
            setQuery(query + input);
            setSelectedIndex(() => 0);
          }
        } else {
          // Normal navigation mode
          if (key.return) {
            if (selected && selected.hasKey) {
              onSelect(selected.id);
            } else if (selected && !selected.hasKey && onConnectProvider) {
              onConnectProvider(selected.provider);
            }
            return;
          }

          if (key.upArrow) {
            setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredItems.length - 1));
            return;
          }

          if (key.downArrow) {
            setSelectedIndex((prev) => (prev < filteredItems.length - 1 ? prev + 1 : 0));
            return;
          }
        }
      },
      [
        phase,
        searchMode,
        selected,
        filteredItems.length,
        onSelect,
        onConnectProvider,
        onBack,
        selectedIndex,
        clearSearch,
        setQuery,
      ]
    ),
    { isActive: phase === 'models' }
  );

  // Helper function for setting selected index (needed for keyboard navigation)
  const setSelectedIndex = useCallback(
    (updater: (prev: number) => number) => {
      // This is a placeholder - in reality, we'd need to lift this state up
      // For now, we'll just call onSelect with the new index
      console.log('Setting selected index:', updater(selectedIndex));
    },
    [selectedIndex]
  );

  // Loading state
  if (loading && models.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} height={height} width={width}>
        <Text color={COLORS.accent} bold>
          Loading models...
        </Text>
        <Text dimColor>Detecting local models and provider availability.</Text>
      </Box>
    );
  }

  // Effort picker phase
  if (phase === 'effort') {
    return (
      <Box flexDirection="column" paddingX={1} height={height} width={width}>
        <Text color={COLORS.accent} bold>
          Reasoning effort
        </Text>
        <Text dimColor>
          {pendingModelId ?? currentModel} {GLYPHS.separator} select effort
        </Text>
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={COLORS.borderAccent}
          paddingX={1}
          width={Math.min(40, width - 4)}
        >
          {EFFORT_LEVELS.map((level, i) => (
            <EffortRow
              key={level}
              level={level}
              isSelected={i === effortIndex}
              isCurrent={level === currentEffort}
            />
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {GLYPHS.arrow} select {GLYPHS.separator} Enter apply {GLYPHS.separator} Esc back
          </Text>
        </Box>
      </Box>
    );
  }

  // Model picker phase
  return (
    <Box flexDirection="column" paddingX={1} height={height} width={width} overflow="hidden">
      {/* Title row */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text color={COLORS.accent} bold>
          Model selector
        </Text>
        <Text dimColor>
          {isSearchActive ? `${filteredCount}/${totalCount}` : totalCount} models {GLYPHS.separator}{' '}
          effort: {formatEffort(currentEffort)}
        </Text>
      </Box>

      {/* Current model indicator */}
      <Box marginBottom={1}>
        <Text dimColor>current {GLYPHS.separator} </Text>
        <Text color={COLORS.success} bold>
          {currentModel || 'none'}
        </Text>
      </Box>

      {/* Search input (shown when in search mode) */}
      {searchMode && (
        <Box marginBottom={1}>
          <Text color={COLORS.accent}>/</Text>
          <Text color={COLORS.muted}> </Text>
          <Text color={COLORS.primary}>{query || ' '}</Text>
        </Box>
      )}

      {/* L-bracket bordered list */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={COLORS.borderAccent}
        paddingX={1}
        height={Math.min(visibleRows + 2, height - 5)}
        overflow="hidden"
      >
        {windowStart > 0 && (
          <Text dimColor>
            {GLYPHS.arrow} {windowStart} more
          </Text>
        )}
        {rows.map((row) => {
          if (row.kind === 'header') {
            return (
              <Box key={`h-${row.provider}`} flexDirection="row" justifyContent="space-between">
                <Text color={COLORS.warning} bold>
                  {row.providerName}
                </Text>
                {!row.hasAnyKey && (
                  <Text color={COLORS.error} dimColor>
                    no key
                  </Text>
                )}
              </Box>
            );
          }

          const { model, globalIndex } = row;
          return (
            <ModelRow
              key={`${model.provider}-${model.id}`}
              model={model}
              isSelected={globalIndex === selectedIndex}
              isCurrent={model.id === currentModel}
              query={query}
            />
          );
        })}
        {windowEnd < filteredItems.length && (
          <Text dimColor>
            {GLYPHS.arrow} {filteredItems.length - windowEnd} more
          </Text>
        )}
      </Box>

      {/* Footer hints */}
      <Box marginTop={1} flexDirection="column">
        {selected && !selected.hasKey ? (
          <Text color={COLORS.warning}>
            No key for {selected.providerName}. Enter/C connect {GLYPHS.separator} /connect{' '}
            {selected.provider}
          </Text>
        ) : (
          <KeyboardShortcutHint
            shortcuts={[
              { key: GLYPHS.arrow, action: 'navigate' },
              { key: 'Enter', action: 'select' },
              { key: 'Tab', action: 'search' },
              { key: 'Esc', action: 'back' },
            ]}
          />
        )}
      </Box>
    </Box>
  );
}

export default ModelsScreenEnhanced;