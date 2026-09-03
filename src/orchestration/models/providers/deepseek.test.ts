import { describe, expect, it } from 'vitest';
import { DeepSeekProvider } from './deepseek';

describe('DeepSeekProvider', () => {
  it('requires an API key', () => {
    expect(() => new DeepSeekProvider({ baseUrl: 'https://deepseek.test/v1' })).toThrow('DEEPSEEK_API_KEY');
  });
});
