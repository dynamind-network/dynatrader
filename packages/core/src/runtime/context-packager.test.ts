import { describe, it, expect } from 'vitest';
import { packText, packPreview } from './context-packager';

describe('context-packager', () => {
  it('keeps both head and tail when packing long text', () => {
    const packed = packText(`start-${'a'.repeat(200)}-end`, 40, 12);
    expect(packed.truncated).toBe(true);
    expect(packed.text).toMatch(/^star/);
    expect(packed.text).toMatch(/\[truncated \d+ chars\]/);
    expect(packed.text).toContain('-end');
  });

  it('creates a compact preview for objects', () => {
    const preview = packPreview({ alpha: 'one', beta: 'two', gamma: 'three', delta: 'four' }, 80);
    expect(preview).toContain('alpha');
    expect(preview.length).toBeLessThanOrEqual(80);
  });
});
