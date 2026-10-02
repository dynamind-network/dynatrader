import { describe, it, expect } from 'vitest';
import React from 'react';
import { buildShortcutHintText, joinKeys, KeyboardShortcutHint } from './KeyboardShortcutHint.js';

describe('KeyboardShortcutHint', () => {
  describe('joinKeys', () => {
    it('returns single key as-is', () => {
      expect(joinKeys(['Enter'])).toBe('Enter');
    });

    it('joins two keys with +', () => {
      expect(joinKeys(['ctrl', 'o'])).toBe('ctrl+o');
    });

    it('joins three keys with +', () => {
      expect(joinKeys(['ctrl', 'shift', 'k'])).toBe('ctrl+shift+k');
    });

    it('handles single key with special characters', () => {
      expect(joinKeys(['up/down'])).toBe('up/down');
    });
  });

  describe('buildShortcutHintText', () => {
    it('renders a single key hint with default inline variant', () => {
      const result = buildShortcutHintText({ keys: ['Enter'], label: 'confirm' });
      expect(result).toBe('Enter to confirm');
    });

    it('renders multiple keys as chord combination joined with +', () => {
      const result = buildShortcutHintText({
        keys: ['ctrl', 'o'],
        label: 'expand',
      });
      expect(result).toBe('ctrl+o to expand');
    });

    it('supports parens variant wrapping output in parentheses', () => {
      const result = buildShortcutHintText({
        keys: ['Esc'],
        label: 'cancel',
        variant: 'parens',
      });
      expect(result).toBe('(Esc to cancel)');
    });

    it('supports inline variant without parentheses', () => {
      const result = buildShortcutHintText({
        keys: ['Tab'],
        label: 'toggle',
        variant: 'inline',
      });
      expect(result).toBe('Tab to toggle');
    });

    it('renders multiple keys with parens variant', () => {
      const result = buildShortcutHintText({
        keys: ['ctrl', 'o'],
        label: 'open',
        variant: 'parens',
      });
      expect(result).toBe('(ctrl+o to open)');
    });

    it('renders single key with parens variant', () => {
      const result = buildShortcutHintText({
        keys: ['Enter'],
        label: 'select',
        variant: 'parens',
      });
      expect(result).toBe('(Enter to select)');
    });

    it('joins multiple keys with + for chord combinations', () => {
      const result = buildShortcutHintText({
        keys: ['ctrl', 'shift', 'k'],
        label: 'command',
      });
      expect(result).toBe('ctrl+shift+k to command');
    });

    it('handles arrow key notation', () => {
      const result = buildShortcutHintText({
        keys: ['up/down'],
        label: 'navigate',
      });
      expect(result).toBe('up/down to navigate');
    });

    it('handles complex multi-key hint with parens', () => {
      const result = buildShortcutHintText({
        keys: ['ctrl', 'p'],
        label: 'search',
        variant: 'parens',
      });
      expect(result).toBe('(ctrl+p to search)');
    });
  });

  describe('KeyboardShortcutHint component', () => {
    it('returns a React element for inline variant', () => {
      const element = KeyboardShortcutHint({ keys: ['Enter'], label: 'confirm' });
      expect(element).toBeDefined();
      expect(React.isValidElement(element)).toBe(true);
    });

    it('returns a React element for parens variant', () => {
      const element = KeyboardShortcutHint({
        keys: ['Esc'],
        label: 'cancel',
        variant: 'parens',
      });
      expect(element).toBeDefined();
      expect(React.isValidElement(element)).toBe(true);
    });

    it('returns a React element with bold shortcut', () => {
      const element = KeyboardShortcutHint({
        keys: ['Enter'],
        label: 'confirm',
        bold: true,
      });
      expect(element).toBeDefined();
      expect(React.isValidElement(element)).toBe(true);
    });

    it('returns a React element for multi-key chord', () => {
      const element = KeyboardShortcutHint({
        keys: ['ctrl', 'p'],
        label: 'search',
        variant: 'parens',
      });
      expect(element).toBeDefined();
      expect(React.isValidElement(element)).toBe(true);
    });
  });
});

