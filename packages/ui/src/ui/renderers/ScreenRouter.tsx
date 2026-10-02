import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { COLORS, GLYPHS } from '../design/tokens.js';
import type { CatalogModel, EffortLevel } from '../../core/providers/catalog.js';
import { HelpScreen } from '../screens/HelpScreen.js';
import { MarketsScreen } from '../screens/MarketsScreen.js';
import { ChartScreen } from '../screens/ChartScreen.js';
import { PortfolioScreen } from '../screens/PortfolioScreen.js';
import { ModelsScreen, type ModelsScreenPhase } from '../screens/ModelsScreen.js';
import { TradesScreen } from '../screens/TradesScreen.js';
import { AlertsScreen } from '../screens/AlertsScreen.js';
import { AnalysisScreen } from '../screens/AnalysisScreen.js';
import { NewsScreen } from '../screens/NewsScreen.js';
import { WatchlistScreen } from '../screens/WatchlistScreen.js';
import { SearchScreen } from '../screens/SearchScreen.js';
import { AutoHedgeScreen } from '../screens/AutoHedgeScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { OrderBookScreen } from '../screens/OrderBookScreen.js';

interface ScreenRouterProps {
  activeScreen: string;
  onBack: () => void;
  terminalSize: { width: number; height: number };
  workspaceDir?: string;
  currentModel?: string;
  apiKeys?: Record<string, string>;
  onModelSelect?: (modelId: string) => void;
  showThinking?: boolean;
  onToggleThinking?: () => void;
  /** ModelsScreen wiring */
  selectedModelIndex?: number;
  onSelectedModelIndexChange?: (index: number) => void;
  currentEffort?: EffortLevel;
  effortIndex?: number;
  modelPickerPhase?: ModelsScreenPhase;
  pendingModelId?: string | null;
  onEffortSelect?: (effort: EffortLevel) => void;
  onConnectProvider?: (provider: string) => void;
  onModelsLoaded?: (models: CatalogModel[]) => void;
  selectedMarketSymbol?: string;
  onSelectedMarketSymbolChange?: (symbol: string) => void;
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
  workspaceDir,
  currentModel,
  apiKeys,
  onModelSelect,
  showThinking,
  onToggleThinking,
  selectedModelIndex = 0,
  onSelectedModelIndexChange,
  currentEffort = 'none',
  effortIndex = 0,
  modelPickerPhase = 'models',
  pendingModelId = null,
  onEffortSelect,
  onConnectProvider,
  onModelsLoaded,
  selectedMarketSymbol,
  onSelectedMarketSymbolChange,
}: ScreenRouterProps): React.ReactElement {
  const commonProps = {
    onBack,
    terminalSize,
  };

  switch (activeScreen) {
    case 'help':
      return <HelpScreen {...commonProps} />;
    case 'markets':
      return <MarketsScreen {...commonProps} terminalSize={terminalSize} workspaceDir={workspaceDir} selectedMarketSymbol={selectedMarketSymbol} onSelectedMarketSymbolChange={onSelectedMarketSymbolChange} />;
    case 'chart':
      return <ChartScreen {...commonProps} terminalSize={terminalSize} workspaceDir={workspaceDir} selectedMarketSymbol={selectedMarketSymbol} onSelectedMarketSymbolChange={onSelectedMarketSymbolChange} />;
    case 'portfolio':
      return <PortfolioScreen {...commonProps} terminalSize={terminalSize} workspaceDir={workspaceDir} />;
    case 'trades':
      return <TradesScreen {...commonProps} terminalSize={terminalSize} workspaceDir={workspaceDir} />;
    case 'alerts':
      return <AlertsScreen {...commonProps} />;
    case 'analysis':
      return <AnalysisScreen {...commonProps} terminalSize={terminalSize} workspaceDir={workspaceDir} selectedMarketSymbol={selectedMarketSymbol} onSelectedMarketSymbolChange={onSelectedMarketSymbolChange} />;
    case 'news':
      return <NewsScreen {...commonProps} terminalSize={terminalSize} workspaceDir={workspaceDir} />;
    case 'watchlist':
      return <WatchlistScreen {...commonProps} />;
    case 'search':
      return <SearchScreen {...commonProps} />;
    case 'autohedge':
      return <AutoHedgeScreen {...commonProps} />;
    case 'settings':
      return <SettingsScreen {...commonProps} showThinking={showThinking ?? true} onToggleThinking={onToggleThinking ?? (() => {})} />;
    case 'orderbook':
      return <OrderBookScreen {...commonProps} />;
    case 'models':
      return <ModelsScreen
          currentModel={currentModel ?? ''}
          apiKeys={apiKeys ?? {}}
          onSelect={onModelSelect ?? (() => {})}
          onBack={onBack}
          selectedIndex={selectedModelIndex}
          onSelectedIndexChange={onSelectedModelIndexChange}
          currentEffort={currentEffort}
          effortIndex={effortIndex}
          phase={modelPickerPhase}
          pendingModelId={pendingModelId}
          onEffortSelect={onEffortSelect}
          onConnectProvider={onConnectProvider}
          onModelsLoaded={onModelsLoaded}
          height={terminalSize.height}
          width={terminalSize.width}
        />;
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

