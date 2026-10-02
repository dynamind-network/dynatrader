import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../src/ui/renderers/ScreenRouter.tsx');
const source = readFileSync(sourcePath, 'utf-8');

describe('ScreenRouter', () => {
  // --- File existence ---
  it('source file exists and is non-empty', () => {
    expect(source.length).toBeGreaterThan(0);
  });

  // --- Exports ---
  it('exports a named ScreenRouter function', () => {
    expect(source).toContain('export function ScreenRouter');
  });

  // --- Imports ---
  it('imports all screen components from screens/index.js', () => {
    expect(source).toContain("from '../screens/index.js'");
    const expectedScreens = [
      'HelpScreen',
      'MarketsScreen',
      'ChartScreen',
      'PortfolioScreen',
      'ModelsScreen',
      'TradesScreen',
      'AlertsScreen',
      'AnalysisScreen',
      'NewsScreen',
      'WatchlistScreen',
      'SearchScreen',
      'AutoHedgeScreen',
      'SettingsScreen',
      'OrderBookScreen',
    ];
    for (const screen of expectedScreens) {
      expect(source).toContain(screen);
    }
  });

  it('imports React and Box from ink', () => {
    expect(source).toContain("import React from 'react'");
    expect(source).toContain("import { Box } from 'ink'");
  });

  // --- Props interface ---
  it('defines ScreenRouterProps interface', () => {
    expect(source).toContain('interface ScreenRouterProps');
  });

  it('accepts activeScreen prop', () => {
    expect(source).toContain('activeScreen:');
  });

  it('accepts onBack prop', () => {
    expect(source).toContain('onBack:');
  });

  it('accepts terminalSize prop', () => {
    expect(source).toContain('terminalSize:');
  });

  it('accepts currentModel prop', () => {
    expect(source).toContain('currentModel');
  });

  it('accepts apiKeys prop', () => {
    expect(source).toContain('apiKeys');
  });

  it('accepts onModelSelect prop', () => {
    expect(source).toContain('onModelSelect');
  });

  // --- Switch cases (all screens from App.tsx renderActiveScreen) ---
  it('has switch on activeScreen', () => {
    expect(source).toContain('switch (activeScreen)');
  });

  it('has case for help screen', () => {
    expect(source).toContain("case 'help':");
    expect(source).toContain('<HelpScreen');
  });

  it('has case for markets screen', () => {
    expect(source).toContain("case 'markets':");
    expect(source).toContain('<MarketsScreen');
  });

  it('has case for chart screen', () => {
    expect(source).toContain("case 'chart':");
    expect(source).toContain('<ChartScreen');
  });

  it('has case for portfolio screen', () => {
    expect(source).toContain("case 'portfolio':");
    expect(source).toContain('<PortfolioScreen');
  });

  it('has case for trades screen', () => {
    expect(source).toContain("case 'trades':");
    expect(source).toContain('<TradesScreen');
  });

  it('has case for alerts screen', () => {
    expect(source).toContain("case 'alerts':");
    expect(source).toContain('<AlertsScreen');
  });

  it('has case for analysis screen', () => {
    expect(source).toContain("case 'analysis':");
    expect(source).toContain('<AnalysisScreen');
  });

  it('has case for news screen', () => {
    expect(source).toContain("case 'news':");
    expect(source).toContain('<NewsScreen');
  });

  it('has case for watchlist screen', () => {
    expect(source).toContain("case 'watchlist':");
    expect(source).toContain('<WatchlistScreen');
  });

  it('has case for search screen', () => {
    expect(source).toContain("case 'search':");
    expect(source).toContain('<SearchScreen');
  });

  it('has case for autohedge screen', () => {
    expect(source).toContain("case 'autohedge':");
    expect(source).toContain('<AutoHedgeScreen');
  });

  it('has case for settings screen', () => {
    expect(source).toContain("case 'settings':");
    expect(source).toContain('<SettingsScreen');
  });

  it('has case for orderbook screen', () => {
    expect(source).toContain("case 'orderbook':");
    expect(source).toContain('<OrderBookScreen');
  });

  it('has case for models screen with special handling', () => {
    expect(source).toContain("case 'models':");
    expect(source).toContain('<ModelsScreen');
    expect(source).toContain('currentModel');
    expect(source).toContain('apiKeys');
    expect(source).toContain('onSelect');
  });

  it('has default case returning null or empty Box', () => {
    expect(source).toContain('default:');
    // Default should return either null or an empty Box
    expect(
      source.includes('return null') || source.includes('<Box />') || source.includes('<Box></Box>')
    ).toBe(true);
  });

  // --- Structural integrity ---
  it('spreads commonProps to standard screens', () => {
    expect(source).toContain('commonProps');
    expect(source).toContain('onBack');
    expect(source).toContain('terminalSize');
  });

  it('passes onBack directly to ModelsScreen', () => {
    // ModelsScreen has its own rendering block but should still get onBack
    expect(source).toContain('onBack={onBack}');
  });

  // --- No dependency on App.tsx internals ---
  it('does not import from App.tsx', () => {
    expect(source).not.toContain('from ../App');
    expect(source).not.toContain('from "./App');
    expect(source).not.toContain('from "../../App');
  });

  it('does not import useState or useEffect (pure routing component)', () => {
    expect(source).not.toContain('useState');
    expect(source).not.toContain('useEffect');
  });

  // --- Complete screen coverage (matches App.tsx renderActiveScreen exactly) ---
  it('covers all 14 screen cases', () => {
    const caseMatches = source.match(/case\s+'[^']+':/g);
    expect(caseMatches).not.toBeNull();
    // 14 screen cases: help, markets, chart, portfolio, trades, alerts, analysis,
    // news, watchlist, search, autohedge, settings, orderbook, models
    expect(caseMatches!.length).toBe(14);
  });
});
