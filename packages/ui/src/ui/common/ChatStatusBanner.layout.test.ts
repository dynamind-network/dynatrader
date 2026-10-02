import { describe, expect, it } from 'vitest';
import { getApprovalLayout, wrapText } from './ChatStatusBanner.js';

describe('approval prompt layout', () => {
  it('uses terminal width for the bordered prompt and switches to compact mode on narrow terminals', () => {
    expect(getApprovalLayout(100, 30)).toEqual({ compact: false, width: 96, detailRows: 4 });
    expect(getApprovalLayout(42, 30)).toEqual({ compact: true, width: 42, detailRows: 4 });
  });

  it('limits request detail height while leaving the decision options present', () => {
    expect(getApprovalLayout(100, 15).detailRows).toBe(0);
    expect(getApprovalLayout(100, 19).detailRows).toBe(2);
    expect(getApprovalLayout(100, 40).detailRows).toBe(4);
  });

  it('wraps long command text without discarding its tail', () => {
    const command = '0123456789 abcdefghijklmnop';
    const lines = wrapText(command, 8);
    expect(lines.join('')).toContain('0123456789');
    expect(lines.slice(-2).join('')).toBe('abcdefghijklmnop');
    expect(lines.every((line) => line.length <= 8)).toBe(true);
  });
});
