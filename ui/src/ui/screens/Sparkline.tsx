import React from 'react';
import { Text } from 'ink';

interface SparklineProps {
  data: number[];
  width?: number;
  color?: string;
}

// Unicode block characters for sparkline (8 levels)
const BLOCKS = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/**
 * Renders a sparkline chart using Unicode block characters
 */
export function Sparkline({ data, width = 20, color = 'cyan' }: SparklineProps) {
  if (!data || data.length === 0) {
    return <Text dimColor>No data</Text>;
  }

  // Normalize data to fit in width
  const normalized = normalizeData(data, width);

  // Find min/max for scaling
  const min = Math.min(...normalized);
  const max = Math.max(...normalized);
  const range = max - min || 1;

  // Convert to block characters
  const chars = normalized.map((value) => {
    const level = Math.round(((value - min) / range) * 8);
    return BLOCKS[Math.min(level, 8)];
  });

  // Determine trend color
  const trend = data[data.length - 1] >= data[0] ? 'green' : 'red';
  const displayColor = color === 'auto' ? trend : color;

  return (
    <Text color={displayColor as any}>{chars.join('')}</Text>
  );
}

/**
 * Normalize data array to target width using simple resampling
 */
function normalizeData(data: number[], targetWidth: number): number[] {
  if (data.length === targetWidth) return data;

  if (data.length < targetWidth) {
    // Interpolate to expand
    const result: number[] = [];
    for (let i = 0; i < targetWidth; i++) {
      const srcIndex = (i / targetWidth) * (data.length - 1);
      const low = Math.floor(srcIndex);
      const high = Math.ceil(srcIndex);
      const t = srcIndex - low;

      if (high >= data.length) {
        result.push(data[data.length - 1]);
      } else {
        result.push(data[low] * (1 - t) + data[high] * t);
      }
    }
    return result;
  } else {
    // Downsample to shrink
    const result: number[] = [];
    const step = data.length / targetWidth;
    for (let i = 0; i < targetWidth; i++) {
      const start = Math.floor(i * step);
      const end = Math.floor((i + 1) * step);
      const slice = data.slice(start, end);
      result.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    return result;
  }
}

export default Sparkline;
