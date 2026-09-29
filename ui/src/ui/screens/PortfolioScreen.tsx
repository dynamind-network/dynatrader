import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useWallet } from '../../contexts/WalletContext.js';
import { ScreenPaneWorkspace, useScreenPaneController } from '../layout/ScreenPaneWorkspace.js';
import { COLORS } from '../design/tokens.js';
import type { PositionWithPnL } from '../../types/wallet.js';
import {
  useTerminalSize,
  createSeparator,
  getOptimalColumnWidths,
  formatPrice,
  formatQuantity,
  formatPercent,
  formatPnL,
  truncateText,
} from '../ResponsiveLayout.js';

interface PortfolioScreenProps {
  onBack: () => void;
  terminalSize?: { width: number; height: number };
  workspaceDir?: string;
}

export function PortfolioScreen({ onBack, terminalSize: providedSize, workspaceDir }: PortfolioScreenProps) {
  const internalSize = useTerminalSize();
  const outerSize = providedSize ?? internalSize;
  const paneController = useScreenPaneController({ screenId: 'portfolio', workspaceDir, terminalSize: outerSize, paneIds: ['positions', 'risk', 'account'], defaultPanes: ['positions'] });
  const terminalWidth = paneController.viewportFor('positions').width;
  const {
    isConnected,
    isLoading,
    address,
    formattedAddress,
    portfolio,
    positions,
    error,
    refresh,
  } = useWallet();

  useEffect(() => {
    if (isConnected) {
      refresh();
      const interval = setInterval(refresh, 30000);
      return () => clearInterval(interval);
    }
  }, [isConnected]);

  if (!isConnected) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>PORTFOLIO [F3]</Text>
        <Box marginTop={1}>
          <Text color="red">Wallet not connected</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Set PRIVATE_KEY and MAIN_ADDRESS environment variables to connect.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text color="yellow">Esc</Text>
          <Text dimColor> to return</Text>
        </Box>
      </Box>
    );
  }

  if (isLoading && positions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>PORTFOLIO [F3]</Text>
        <Text dimColor>Loading portfolio...</Text>
      </Box>
    );
  }

  if (error && positions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>PORTFOLIO [F3]</Text>
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text color="yellow">Esc</Text>
          <Text dimColor> to return</Text>
        </Box>
      </Box>
    );
  }

  const totalValue = portfolio?.totalValueUsd || 0;
  const totalPnL = positions.reduce((sum, p) => sum + p.pnl, 0);
  const totalCost = positions.reduce((sum, p) => sum + (p.entryPrice * p.quantity), 0);
  const totalPnLPercent = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

  const columnConfigs = [
    { key: 'symbol', header: 'Asset', minWidth: 6, maxWidth: 8, weight: 1 },
    { key: 'chain', header: 'Chain', minWidth: 6, maxWidth: 10, weight: 1 },
    { key: 'quantity', header: 'Qty', minWidth: 8, maxWidth: 12, weight: 1 },
    { key: 'entryPrice', header: 'Entry', minWidth: 8, maxWidth: 12, weight: 1 },
    { key: 'currentPrice', header: 'Current', minWidth: 8, maxWidth: 12, weight: 1 },
    { key: 'pnl', header: 'P&L', minWidth: 10, maxWidth: 16, weight: 1 },
    { key: 'pnlPercent', header: '%', minWidth: 6, maxWidth: 8, weight: 1 },
  ];

  const columnWidths = getOptimalColumnWidths(terminalWidth, columnConfigs);
  const separator = createSeparator(terminalWidth, '-');
  const headerSeparator = createSeparator(terminalWidth, '=');

  const formatRow = (values: string[]) => {
    return values.map((val, i) => {
      const width = columnWidths[i];
      const truncated = truncateText(val, width);
      const key = columnConfigs[i].key;
      if (key === 'pnl') {
        const numVal = parseFloat(val.replace(/[^0-9.-]/g, '')) || 0;
        const color = numVal >= 0 ? 'green' : 'red';
        return (
          <Box key={i} width={width}>
            <Text color={color}>{truncated.padStart(width, ' ')}</Text>
          </Box>
        );
      }
      if (key === 'pnlPercent') {
        const numVal = parseFloat(val.replace(/[^0-9.-]/g, '')) || 0;
        const color = numVal >= 0 ? 'green' : 'red';
        return (
          <Box key={i} width={width}>
            <Text color={color}>{truncated.padStart(width, ' ')}</Text>
          </Box>
        );
      }
      if (key === 'symbol') {
        return (
          <Box key={i} width={width}>
            <Text color="white" bold>{truncated}</Text>
          </Box>
        );
      }
      return (
        <Box key={i} width={width}>
          <Text>{truncated}</Text>
        </Box>
      );
    });
  };

  const mainPane = (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>PORTFOLIO [F3]</Text>
        {formattedAddress && (
          <Text dimColor> - {formattedAddress}</Text>
        )}
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text>Total Value: </Text>
          <Text color="white" bold>${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</Text>
        </Box>
        <Box>
          <Text>Total P&L: </Text>
          <Text color={totalPnL >= 0 ? 'green' : 'red'} bold>
            {totalPnL >= 0 ? '+' : ''}${totalPnL.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            {' '}({totalPnLPercent >= 0 ? '+' : ''}{totalPnLPercent.toFixed(2)}%)
          </Text>
        </Box>
        <Box>
          <Text dimColor>Chains: {portfolio?.chains.join(', ') || 'None'}</Text>
        </Box>
      </Box>

      <Text dimColor>{headerSeparator}</Text>

      {positions.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No positions found. Your wallet may be empty or balances are still loading.</Text>
        </Box>
      ) : (
        <>
          <Box>
            {formatRow(columnConfigs.map(c => c.header))}
          </Box>
          <Text dimColor>{separator}</Text>

          {positions.map((p, idx) => {
            const rowValues = [
              p.symbol,
              p.chain,
              formatQuantity(p.quantity),
              formatPrice(p.entryPrice),
              formatPrice(p.currentPrice),
              formatPnL(p.pnl),
              formatPercent(p.pnlPercent),
            ];
            return (
              <Box key={`${p.symbol}-${p.chain}-${idx}`}>
                {formatRow(rowValues)}
              </Box>
            );
          })}

          <Text dimColor>{separator}</Text>

          <Box marginTop={1} flexDirection="column">
            <Text color="yellow" bold>Allocation</Text>
            {positions.map((p, idx) => {
              const allocation = totalValue > 0 ? (p.valueUsd / totalValue) * 100 : 0;
              const maxBarWidth = Math.min(30, Math.floor(terminalWidth / 4));
              const barWidth = Math.min(maxBarWidth, Math.max(0, Math.round((allocation / 100) * maxBarWidth)));
              const emptyWidth = maxBarWidth - barWidth;
              const symbolWidth = Math.max(4, Math.min(8, Math.floor(terminalWidth / 12)));
              const truncatedSymbol = truncateText(p.symbol, symbolWidth);

              return (
                <Box key={`alloc-${p.symbol}-${p.chain}-${idx}`}>
                  <Box width={symbolWidth}>
                    <Text color="white" bold>{truncatedSymbol}</Text>
                  </Box>
                  <Box width={8}>
                    <Text dimColor>{allocation.toFixed(1).padStart(5)}%</Text>
                  </Box>
                  <Text color="gray">[</Text>
                  <Text color="cyan">{'\u2588'.repeat(barWidth)}</Text>
                  <Text color="gray">{'\u2591'.repeat(emptyWidth)}</Text>
                  <Text color="gray">]</Text>
                  <Text dimColor> ${p.valueUsd.toFixed(2)}</Text>
                </Box>
              );
            })}
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <Text dimColor>{headerSeparator}</Text>
      </Box>
      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor> to return | </Text>
        <Text color="yellow">Alt+M</Text>
        <Text dimColor> for markets | </Text>
        <Text color="yellow">Alt+G</Text>
        <Text dimColor> for chart</Text>
      </Box>
      {isLoading && (
        <Box>
          <Text dimColor>Refreshing...</Text>
        </Box>
      )}
    </Box>
  );

  const concentration = [...positions]
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, 5);

  return (
    <ScreenPaneWorkspace
      controller={paneController}
      terminalSize={outerSize}
      panes={[
        { id: 'positions', title: 'PORTFOLIO · POSITIONS', content: mainPane },
        {
          id: 'exposure',
          title: 'EXPOSURE · TOP HOLDINGS',
          content: (
            <Box flexDirection="column" paddingX={1}>
              <Text color="white" bold>${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} total value</Text>
              <Text color={totalPnL >= 0 ? 'green' : 'red'}>{totalPnL >= 0 ? '+' : ''}${totalPnL.toLocaleString(undefined, { maximumFractionDigits: 2 })} P&L</Text>
              <Text dimColor> </Text>
              {concentration.length ? concentration.map((position) => {
                const share = totalValue > 0 ? position.valueUsd / totalValue * 100 : 0;
                const bar = Math.max(1, Math.round(share / 4));
                return (
                  <Box key={`${position.symbol}-${position.chain}`} flexDirection="column" marginBottom={1}>
                    <Text><Text color={COLORS.accent} bold>{position.symbol}</Text><Text dimColor> {share.toFixed(1)}%</Text></Text>
                    <Text color="cyan">{'█'.repeat(bar)}<Text dimColor>{'░'.repeat(Math.max(0, 25 - bar))}</Text></Text>
                    <Text dimColor>{formatPnL(position.pnl)} · {position.chain}</Text>
                  </Box>
                );
              }) : <Text dimColor>No holdings to display.</Text>}
              <Text dimColor>Ctrl+O to customize panes</Text>
            </Box>
          ),
        },
      ]}
    />
  );
}

export default PortfolioScreen;
