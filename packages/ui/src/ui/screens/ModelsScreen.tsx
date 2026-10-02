import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { MouseRegion } from '../input/MouseInputProvider.js';
import {
  listCatalogModels,
  detectLMStudioModels,
  type CatalogModel,
  type EffortLevel,
  EFFORT_LEVELS,
} from '../../index.js';

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
  onSelectedIndexChange?: (index: number) => void;
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

// ── Subcomponents ────────────────────────────────────────────────────────────

function ModelRow({
  model,
  isSelected,
  isCurrent,
}: {
  model: CatalogModel;
  isSelected: boolean;
  isCurrent: boolean;
}) {
  const ctx = formatContextWindow(model.contextWindow);
  const effort = model.supportsEffort ? 'reasoning' : null;
  const byline = [model.providerName, ctx, effort].filter(Boolean).join(' \u00B7 ');

  return (
    <Box flexDirection="row">
      {/* Pointer / blank */}
      <Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '\u25B8' : ' '}</Text>

      {/* Model name */}
      <Text
        color={!model.hasKey ? 'gray' : isSelected ? 'white' : 'white'}
        bold={isSelected}
        dimColor={!model.hasKey}
      >
        {' '}
        {model.name}
      </Text>

      {/* Checkmark for current (only when not the focused row) */}
      {isCurrent && !isSelected && <Text color="cyan"> {'\u2713'}</Text>}

      {/* Byline */}
      <Text dimColor>
        {' '}
        {'\u00B7'} {byline}
      </Text>

      {/* Missing key badge */}
      {!model.hasKey && (
        <Text color="red">
          {' '}
          {'\u00B7'} no key
        </Text>
      )}
    </Box>
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
    <Box flexDirection="row">
      <Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '\u25B8' : ' '}</Text>
      <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
        {' '}
        {level}
      </Text>
      {isCurrent && (
        <Text color="cyan">
          {' '}
          {'\u2713'}
        </Text>
      )}
    </Box>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function ModelsScreen({
  currentModel,
  apiKeys,
  onSelect,
  currentEffort = 'none',
  onBack,
  selectedIndex,
  effortIndex = 0,
  phase = 'models',
  pendingModelId = null,
  height = 24,
  width = 80,
  onModelsLoaded,
  onSelectedIndexChange,
}: ModelsScreenProps) {
  const [models, setModels] = useState<CatalogModel[]>(() => listCatalogModels(apiKeys));
  const [loading, setLoading] = useState(true);

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
    if (models.length <= visibleRows) return 0;
    const mid = Math.floor(visibleRows / 2);
    let start = selectedIndex - mid;
    if (start < 0) start = 0;
    if (start + visibleRows > models.length) start = Math.max(0, models.length - visibleRows);
    return start;
  }, [models.length, selectedIndex, visibleRows]);

  const windowEnd = Math.min(models.length, windowStart + visibleRows);

  // Build visible rows with provider group headers
  const rows: Array<
    | { kind: 'header'; provider: string; providerName: string; hasAnyKey: boolean }
    | { kind: 'model'; model: CatalogModel; globalIndex: number }
  > = [];

  let lastProvider = '';
  for (let i = windowStart; i < windowEnd; i++) {
    const model = models[i]!;
    if (model.provider !== lastProvider) {
      const hasAnyKey = models.some((m) => m.provider === model.provider && m.hasKey);
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

  const selected = models[selectedIndex] ?? null;

  // ── Loading state ──────────────────────────────────────────────────────
  if (loading && models.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} height={height} width={width}>
        <Text color="cyan" bold>
          Loading models...
        </Text>
        <Text dimColor>Detecting local models and provider availability.</Text>
      </Box>
    );
  }

  // ── Effort picker phase ────────────────────────────────────────────────
  if (phase === 'effort') {
    return (
      <Box flexDirection="column" paddingX={1} height={height} width={width}>
        <Text color="cyan" bold>
          Reasoning effort
        </Text>
        <Text dimColor>
          {pendingModelId ?? currentModel} {'\u00B7'} select effort
        </Text>
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="cyan"
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
            {'\u2191\u2193'} select {'\u00B7'} Enter apply {'\u00B7'} Esc back
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Model picker phase ─────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={1} height={height} width={width} overflow="hidden">
      {/* Title row */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text color="cyan" bold>
          Model selector
        </Text>
        <Text dimColor>
          {models.length} models {'\u00B7'} effort: {formatEffort(currentEffort)}
        </Text>
      </Box>

      {/* Current model indicator */}
      <Box marginBottom={1}>
        <Text dimColor>current {'\u00B7'} </Text>
        <Text color="green" bold>
          {currentModel || 'none'}
        </Text>
      </Box>

      {/* L-bracket bordered list */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        height={Math.min(visibleRows + 2, height - 5)}
        overflow="hidden"
      >
        {windowStart > 0 && (
          <Text dimColor>
            {'\u2191'} {windowStart} more
          </Text>
        )}
        {rows.map((row) => {
          if (row.kind === 'header') {
            return (
              <Box key={`h-${row.provider}`} flexDirection="row" justifyContent="space-between">
                <Text color="yellow" bold>
                  {row.providerName}
                </Text>
                {!row.hasAnyKey && (
                  <Text color="red" dimColor>
                    no key
                  </Text>
                )}
              </Box>
            );
          }

          const { model, globalIndex } = row;
          return (
            <MouseRegion
              key={`${model.provider}-${model.id}`}
              onClick={() => onSelectedIndexChange?.(globalIndex)}
            >
              <ModelRow
                model={model}
                isSelected={globalIndex === selectedIndex}
                isCurrent={model.id === currentModel}
              />
            </MouseRegion>
          );
        })}
        {windowEnd < models.length && (
          <Text dimColor>
            {'\u2193'} {models.length - windowEnd} more
          </Text>
        )}
      </Box>

      {/* Footer hints */}
      <Box marginTop={1} flexDirection="column">
        {selected && !selected.hasKey ? (
          <Text color="yellow">
            No key for {selected.providerName}. Enter/C connect {'\u00B7'} /connect{' '}
            {selected.provider}
          </Text>
        ) : (
          <Text dimColor>
            {'\u2191\u2193'} navigate {'\u00B7'} Enter select {'\u00B7'} C connect {'\u00B7'} Esc back
          </Text>
        )}
      </Box>
    </Box>
  );
}

export default ModelsScreen;

