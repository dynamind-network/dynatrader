import React from 'react';
import { describe, expect, it } from 'vitest';
import { MCPScreen } from './MCPScreen.js';

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap((child) => collectText(child));
  if (React.isValidElement(node)) {
    return collectText((node.props as { children?: unknown }).children);
  }
  return [];
}

function normalizeText(node: unknown): string {
  return collectText(node).join(' ').replace(/\s+/g, ' ').trim();
}

describe('MCPScreen', () => {
  it('renders a compact empty state and navigation hint', () => {
    const element = MCPScreen({
      servers: [],
      onConnect: () => {},
      onDisconnect: () => {},
      onSelect: () => {},
      onBack: () => {},
      selectedIndex: 0,
    });

    const text = normalizeText(element);
    expect(text).toContain('MCP servers');
    expect(text).toContain('No MCP servers configured.');
    expect(text).toContain('Esc back');
  });
});
