import { describe, it, expect } from 'vitest';
import { CCR } from './ccr';

describe('CCR', () => {
  // 1. store() returns a <<ccr:HASH>> marker for a long string
  it('store() returns a <<ccr:HASH>> marker for a long string', async () => {
    const ccr = new CCR();
    const longString = 'a'.repeat(100);
    const result = await ccr.store(longString);
    expect(result.marker).toMatch(/^<<ccr:[a-f0-9]{16}>>$/);
    expect(result.markerLength).toBe(result.marker.length);
  });

  // 2. retrieve() returns original value for a valid marker
  it('retrieve() returns original value for a valid marker', async () => {
    const ccr = new CCR();
    const value = 'This is a test string that is long enough to be stored and retrieved correctly.';
    const { marker } = await ccr.store(value);
    const retrieved = ccr.retrieve(marker);
    expect(retrieved).toBe(value);
  });

  // 3. retrieve() returns null for unknown marker
  it('retrieve() returns null for unknown marker', () => {
    const ccr = new CCR();
    const result = ccr.retrieve('<<ccr:0123456789abcdef>>');
    expect(result).toBeNull();
  });

  // 4. replaceLongStrings() replaces strings over minStringLength
  it('replaceLongStrings() replaces strings over minStringLength', async () => {
    const ccr = new CCR({ minStringLength: 10 });
    const longStr = 'this is a long string that exceeds the minimum length';
    const text = `some text "${longStr}" more text`;
    const result = await ccr.replaceLongStrings(text);
    expect(result.compressed).toContain('<<ccr:');
    expect(result.compressed).not.toContain(longStr);
    expect(result.markers.length).toBe(1);
    expect(result.markers[0].originalLength).toBeGreaterThan(0);
    expect(result.markers[0].replacedLength).toBeGreaterThan(0);
    expect(result.markers[0]).toHaveProperty('key');
    expect(result.markers[0]).toHaveProperty('storedAt');
  });

  // 5. replaceLongStrings() skips strings under minStringLength
  it('replaceLongStrings() skips strings under minStringLength', async () => {
    const ccr = new CCR({ minStringLength: 100 });
    const shortStr = 'short string under the limit';
    const text = `some text "${shortStr}" more text`;
    const result = await ccr.replaceLongStrings(text);
    expect(result.compressed).toBe(text);
    expect(result.markers.length).toBe(0);
  });

  // 6. restoreMarkers() restores all markers to original values
  it('restoreMarkers() restores all markers to original values', async () => {
    const ccr = new CCR({ minStringLength: 10 });
    const value = 'This is a long enough value to be stored and then restored.';
    const { marker } = await ccr.store(value);
    const text = `Some prefix ${marker} some suffix`;
    const restored = ccr.restoreMarkers(text);
    expect(restored).toBe(`Some prefix ${value} some suffix`);
  });

  // 7. Roundtrip: replaceLongStrings then restoreMarkers returns original text
  it('replaceLongStrings then restoreMarkers returns original text', async () => {
    const ccr = new CCR({ minStringLength: 10 });
    const original = 'The quick brown fox jumps over the lazy dog near the big forest';
    const { compressed } = await ccr.replaceLongStrings(original);
    const restored = ccr.restoreMarkers(compressed);
    expect(restored).toBe(original);
  });

  // 8. getStats() returns correct statistics after store operations
  it('getStats() returns correct statistics after store operations', async () => {
    const ccr = new CCR({ minStringLength: 10 });
    const value1 = 'a'.repeat(100);
    const value2 = 'b'.repeat(200);
    await ccr.store(value1);
    await ccr.store(value2);
    const stats = ccr.getStats();
    expect(stats.storedItems).toBe(2);
    expect(stats.totalOriginalBytes).toBeGreaterThan(0);
    expect(stats.totalCompressedBytes).toBeGreaterThan(0);
    expect(stats.totalSavingsBytes).toBe(
      stats.totalOriginalBytes - stats.totalCompressedBytes,
    );
  });

  // 9. clear() empties storage
  it('clear() empties storage', async () => {
    const ccr = new CCR({ minStringLength: 10 });
    const value = 'a'.repeat(100);
    const { marker } = await ccr.store(value);
    expect(ccr.retrieve(marker)).toBe(value);
    ccr.clear();
    expect(ccr.retrieve(marker)).toBeNull();
    const stats = ccr.getStats();
    expect(stats.storedItems).toBe(0);
    expect(stats.totalOriginalBytes).toBe(0);
    expect(stats.totalCompressedBytes).toBe(0);
  });

  // 10. SHA-256 markers are deterministic (same input = same hash)
  it('SHA-256 markers are deterministic for same input', async () => {
    const ccr = new CCR();
    const value = 'This is a deterministic test string that is long enough to produce a consistent hash.';
    const result1 = await ccr.store(value);
    const result2 = await ccr.store(value);
    expect(result1.marker).toBe(result2.marker);
  });

  // 11. Multiple strings are each stored/replaced independently
  it('Multiple strings are each stored/replaced independently', async () => {
    const ccr = new CCR({ minStringLength: 10 });
    const str1 = 'first long string value that should be replaced';
    const str2 = 'second long string value that should be replaced';
    const text = `"${str1}" and "${str2}"`;
    const result = await ccr.replaceLongStrings(text);
    expect(result.markers.length).toBe(2);
    // Verify markers are different (different content = different hash)
    expect(result.markers[0].key).not.toBe(result.markers[1].key);
    // Each marker should be restorable individually
    const markers = result.compressed.match(/<<ccr:[a-f0-9]{16}>>/g);
    expect(markers).toHaveLength(2);
    const restored = ccr.restoreMarkers(result.compressed);
    expect(restored).toBe(text);
  });

  // 12. Edge case: empty input returns empty output
  it('empty input returns empty output', async () => {
    const ccr = new CCR();
    const result = await ccr.replaceLongStrings('');
    expect(result.compressed).toBe('');
    expect(result.markers).toEqual([]);
  });

  // 13. store() with string shorter than minStringLength returns marker but skips storage
  it('store() with short string returns marker but does not store', async () => {
    const ccr = new CCR({ minStringLength: 100 });
    const shortStr = 'short';
    const { marker } = await ccr.store(shortStr);
    expect(marker).toMatch(/^<<ccr:[a-f0-9]{16}>>$/);
    // Should not be retrievable
    expect(ccr.retrieve(marker)).toBeNull();
  });

  // 14. Config uses defaults when not provided
  it('uses default configuration when no config provided', async () => {
    const ccr = new CCR();
    // Default minStringLength is 50
    const value49 = 'a'.repeat(49);
    const value50 = 'a'.repeat(50);
    const result49 = await ccr.store(value49); // too short
    const result50 = await ccr.store(value50); // meets minimum
    expect(ccr.retrieve(result49.marker)).toBeNull();
    expect(ccr.retrieve(result50.marker)).toBe(value50);
  });
});

