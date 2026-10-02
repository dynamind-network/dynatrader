import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { useTerminalSize, type TerminalSize } from '../hooks/useTerminalSize.js';
import {
  createSeparator,
  getOptimalColumnWidths,
  getScreenBreakpoints,
  truncateText,
  formatPrice,
  formatQuantity,
  formatPercent,
  formatPnL,
  type TerminalSize as TerminalSizeType,
} from '../utils/terminal.js';

export interface ColumnConfig {
  key: string;
  header: string;
  minWidth: number;
  maxWidth?: number;
  weight?: number;
  align?: 'left' | 'center' | 'right';
}

interface ResponsiveTableProps {
  columns: ColumnConfig[];
  rows: Record<string, string | number>[];
  terminalSize?: TerminalSizeType;
  leftPad?: string;
  rowKey?: (row: Record<string, string | number>, index: number) => string;
}

export function ResponsiveTable({
  columns,
  rows,
  terminalSize: providedSize,
  leftPad = '  ',
  rowKey,
}: ResponsiveTableProps) {
  const size = providedSize ?? useTerminalSize();
  const { width: terminalWidth } = size;

  const columnWidths = getOptimalColumnWidths(
    terminalWidth,
    columns.map(col => ({ minWidth: col.minWidth, maxWidth: col.maxWidth, weight: col.weight ?? 1 }))
  );

  const headerRow = columns.map((col, i) =>
    truncateText(col.header, columnWidths[i]).padEnd(columnWidths[i], ' ')
  ).join('  ');

  return (
    <Box flexDirection="column">
      <Text>{leftPad}{headerRow}</Text>
      <Text dimColor>{leftPad}{createSeparator(terminalWidth, '-')}</Text>
      {rows.map((row, index) => {
        const key = rowKey ? rowKey(row, index) : `row-${index}`;
        const cells = columns.map((col, i) => {
          const value = row[col.key];
          const cellText = typeof value === 'number' ? formatCellValue(value, col.key) : String(value ?? '');
          const truncated = truncateText(cellText, columnWidths[i]);
          return col.align === 'right' ? truncated.padStart(columnWidths[i], ' ') : truncated.padEnd(columnWidths[i], ' ');
        }).join('  ');
        return (
          <Text key={key}>{leftPad}{cells}</Text>
        );
      })}
    </Box>
  );
}

function formatCellValue(value: number, columnKey: string): string {
  if (columnKey.toLowerCase().includes('price') || columnKey.toLowerCase().includes('value')) {
    return formatPrice(value);
  }
  if (columnKey.toLowerCase().includes('quantity') || columnKey.toLowerCase().includes('qty')) {
    return formatQuantity(value);
  }
  if (columnKey.toLowerCase().includes('percent') || columnKey.toLowerCase().includes('pct') || columnKey.toLowerCase().includes('pnlpercent')) {
    return formatPercent(value);
  }
  if (columnKey.toLowerCase().includes('pnl')) {
    return formatPnL(value);
  }
  return String(value);
}

interface ResponsiveListProps {
  items: Array<{ id: string; label: string; value: string | number; color?: string }>;
  terminalSize?: TerminalSizeType;
  leftPad?: string;
  maxItems?: number;
}

export function ResponsiveList({
  items,
  terminalSize: providedSize,
  leftPad = '  ',
  maxItems,
}: ResponsiveListProps) {
  const size = providedSize ?? useTerminalSize();
  const { height: terminalHeight } = size;
  const { isCompact } = getScreenBreakpoints(size.width);

  const displayItems = maxItems ? items.slice(0, maxItems) : items;

  return (
    <Box flexDirection="column">
      {displayItems.map((item, index) => {
        const valueText = typeof item.value === 'number' ? formatNumberValue(item.value) : String(item.value);
        const truncatedLabel = truncateText(item.label, isCompact ? 20 : 30);
        const truncatedValue = truncateText(valueText, isCompact ? 12 : 16);
        const color = item.color ?? (String(item.value).startsWith('+') ? 'green' : String(item.value).startsWith('-') ? 'red' : 'white');

        return (
          <Box key={item.id}>
            <Text>{leftPad}</Text>
            <Text color="white" bold>{truncatedLabel}</Text>
            <Text> </Text>
            <Text color={color}>{truncatedValue}</Text>
          </Box>
        );
      })}
      {maxItems && items.length > maxItems && (
        <Text dimColor>{leftPad}... and {items.length - maxItems} more</Text>
      )}
    </Box>
  );
}

function formatNumberValue(value: number): string {
  if (Math.abs(value) >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1000) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return `$${value.toFixed(2)}`;
}

interface ResponsiveCardProps {
  title: string;
  children: React.ReactNode;
  terminalSize?: TerminalSizeType;
  leftPad?: string;
}

export function ResponsiveCard({
  title,
  children,
  terminalSize: providedSize,
  leftPad = '  ',
}: ResponsiveCardProps) {
  const size = providedSize ?? useTerminalSize();
  const separator = createSeparator(size.width, '=');

  return (
    <Box flexDirection="column">
      <Text>{leftPad}{separator}</Text>
      <Text>{leftPad}{title}</Text>
      <Box marginLeft={2}>{children}</Box>
      <Text>{leftPad}{separator}</Text>
    </Box>
  );
}

interface ResponsiveGridProps {
  items: Array<{ label: string; value: string | number }>;
  terminalSize?: TerminalSizeType;
  columns?: number;
  leftPad?: string;
}

export function ResponsiveGrid({
  items,
  terminalSize: providedSize,
  columns: requestedColumns,
  leftPad = '  ',
}: ResponsiveGridProps) {
  const size = providedSize ?? useTerminalSize();
  const breakpoints = getScreenBreakpoints(size.width);
  const columns = requestedColumns ?? breakpoints.columnCount;

  const rows: Array<Array<{ label: string; value: string | number }>> = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns));
  }

  const labelWidth = Math.floor(size.width / columns) - 15;
  const valueWidth = 10;

  return (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex}>
          <Text>{leftPad}</Text>
          {row.map((item, colIndex) => {
            const truncatedLabel = truncateText(item.label, labelWidth);
            const valueText = typeof item.value === 'number' ? formatNumberValue(item.value) : String(item.value);
            const truncatedValue = truncateText(valueText, valueWidth);
            const color = typeof item.value === 'number' && item.value < 0 ? 'red' : 'white';

            return (
              <Box key={colIndex} width={Math.floor(size.width / columns)}>
                <Text color="white">{truncatedLabel}</Text>
                <Text> </Text>
                <Text color={color}>{truncatedValue}</Text>
              </Box>
            );
          })}
          {row.length < columns && (
            <Box width={size.width - (leftPad.length + row.length * Math.floor(size.width / columns))}>
              <Text></Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}

export { useTerminalSize, useTerminalWidth, useTerminalHeight, useOnResize } from '../hooks/useTerminalSize.js';
export * from '../utils/terminal.js';

