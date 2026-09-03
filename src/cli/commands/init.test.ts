import { describe, expect, it } from 'vitest';
import { validateInitAnswers } from './init';

describe('init validation', () => {
  it('flags live execution without exchange credentials', () => {
    const issues = validateInitAnswers({
      exchange: '',
      tradingMode: 'live',
      apiKey: '',
      apiSecret: '',
      riskLevel: 'conservative',
      modelProvider: 'openai',
      modelName: 'gpt-4o-mini',
      enableTelegram: false,
      enableDiscord: false,
    });

    expect(issues.some((issue) => issue.level === 'error' && issue.title.includes('Exchange is required'))).toBe(true);
    expect(issues.some((issue) => issue.level === 'error' && issue.title.includes('Exchange credentials'))).toBe(true);
  });

  it('warns when model configuration is still blank', () => {
    const issues = validateInitAnswers({
      exchange: 'binance',
      tradingMode: 'paper',
      apiKey: '',
      apiSecret: '',
      riskLevel: 'moderate',
      modelProvider: '',
      modelName: '',
      enableTelegram: false,
      enableDiscord: false,
    });

    expect(issues.some((issue) => issue.level === 'warning' && issue.title.includes('Model provider'))).toBe(true);
    expect(issues.some((issue) => issue.level === 'warning' && issue.title.includes('Model name'))).toBe(true);
  });
});
