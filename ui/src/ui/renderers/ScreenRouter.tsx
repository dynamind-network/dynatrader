import React from 'react';
import { Box, Text } from 'ink';
import {
  HelpScreen,
  MarketsScreen,
  ChartScreen,
  PortfolioScreen,
  ModelsScreen,
  TradesScreen,
  AlertsScreen,
  AnalysisScreen,
  NewsScreen,
  WatchlistScreen,
  SearchScreen,
  AutoHedgeScreen,
  SettingsScreen,
  OrderBookScreen,
} from '../screens/index.js';
import { COLORS, GLYPHS } from '../design/tokens.js';
import type { CatalogModel, EffortLevel } from '../../index.js';
import type { ModelsScreenPhase } from '../screens/ModelsScreen.js';

interface ScreenRouterProps {
  activeScreen: string;
  onBack: () => void;
  terminalSize: { width: number; height: number };
  currentModel?: string;
  apiKeys?: Record<string, string>;
  onModelSelect?: (modelId: string) => void;
  showThinking?: boolean;
  onToggleThinking?: () => void;
  /** ModelsScreen wiring */
  selectedModelIndex?: number;
  currentEffort?: EffortLevel;
  effortIndex?: number;
  modelPickerPhase?: ModelsScreenPhase;
  pendingModelId?: string | null;
  onEffortSelect?: (effort: EffortLevel) => void;
  onConnectProvider?: (provider: string) => void;
  onModelsLoaded?: (models: CatalogModel[]) => void;
}

/**
 * ScreenRouter - Renders the active screen based on the activeScreen prop.
 * Extracted from App.tsx renderActiveScreen() function.
 *
 * Also exported as StandaloneScreenRenderer for use in split-pane layouts
 * and other contexts outside the main router.
 */
export const StandaloneScreenRenderer = ScreenRouter;

export function ScreenRouter({
  activeScreen,
  onBack,
  terminalSize,
  currentModel,
  apiKeys,
  onModelSelect,
  showThinking,
  onToggleThinking,
  selectedModelIndex = 0,
  currentEffort = 'none',
  effortIndex = 0,
  modelPickerPhase = 'models',
  pendingModelId = null,
  onEffortSelect,
  onConnectProvider,
  onModelsLoaded,
}: ScreenRouterProps): React.ReactElement {
  const commonProps = {
    onBack,
    terminalSize,
  };

  switch (activeScreen) {
    case 'help':
      return <HelpScreen {...commonProps} />;
    case 'markets':
      return <MarketsScreen {...commonProps} />;
    case 'chart':
      return <ChartScreen {...commonProps} />;
    case 'portfolio':
      return <PortfolioScreen {...commonProps} />;
    case 'trades':
      return <TradesScreen {...commonProps} />;
    case 'alerts':
      return <AlertsScreen {...commonProps} />;
    case 'analysis':
      return <AnalysisScreen {...commonProps} />;
    case 'news':
      return <NewsScreen {...commonProps} />;
    case 'watchlist':
      return <WatchlistScreen {...commonProps} />;
    case 'search':
      return <SearchScreen {...commonProps} />;
    case 'autohedge':
      return <AutoHedgeScreen {...commonProps} />;
    case 'settings':
      return (
        <SettingsScreen
          {...commonProps}
          showThinking={showThinking ?? true}
          onToggleThinking={onToggleThinking ?? (() => {})}
        />
      );
    case 'orderbook':
      return <OrderBookScreen {...commonProps} />;
    case 'models':
      return (
        <ModelsScreen
          currentModel={currentModel ?? ''}
          apiKeys={apiKeys ?? {}}
          onSelect={onModelSelect ?? (() => {})}
          onBack={onBack}
          selectedIndex={selectedModelIndex}
          currentEffort={currentEffort}
          effortIndex={effortIndex}
          phase={modelPickerPhase}
          pendingModelId={pendingModelId}
          onEffortSelect={onEffortSelect}
          onConnectProvider={onConnectProvider}
          onModelsLoaded={onModelsLoaded}
          height={terminalSize.height}
          width={terminalSize.width}
        />
      );
    default:
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text color={COLORS.error}>Unknown screen: {activeScreen}</Text>
          <Text color={COLORS.muted}>
            {GLYPHS.separator} Available screens: Help, Markets, Portfolio, Trades, Alerts,
            Analysis, News, Watchlist, Chart, Search, AutoHedge, Settings, OrderBook, Models
          </Text>
        </Box>
      );
  }
}
