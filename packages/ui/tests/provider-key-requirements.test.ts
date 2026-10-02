import { describe, expect, it } from 'vitest';
import { providerRequiresApiKey } from '../src/core/providers/catalog.js';

describe('provider API key requirements', () => {
  it('treats local Ollama and LM Studio as keyless providers', () => {
    expect(providerRequiresApiKey('ollama')).toBe(false);
    expect(providerRequiresApiKey('lmstudio')).toBe(false);
    expect(providerRequiresApiKey('deepseek')).toBe(true);
    expect(providerRequiresApiKey(null)).toBe(true);
  });

});
