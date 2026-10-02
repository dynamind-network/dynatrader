import { describe, expect, it } from 'vitest';
import { applyModelsDevCatalog } from './models-dev.js';
import type { ProviderEntry } from './types.js';

function provider(defaultModel: string, models: ProviderEntry['models']): ProviderEntry {
  return {
    name: 'deepseek',
    displayName: 'DeepSeek',
    env: ['DEEPSEEK_API_KEY'],
    baseUrl: 'https://api.deepseek.com',
    defaultModel,
    models,
  };
}

describe('models.dev model catalog', () => {
  it('uses current supported models, drops deprecated entries, and updates a stale bundled default', () => {
    const providers = {
      deepseek: provider('deepseek-chat', [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128000, maxOutput: 8192 },
        { id: 'my-private-model', name: 'Private', contextWindow: 32768, maxOutput: 4096 },
      ]),
    };

    applyModelsDevCatalog(providers, { deepseek: new Set(['deepseek-chat']) }, {
      deepseek: {
        name: 'DeepSeek',
        models: {
          'deepseek-reasoner': {
            id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', tool_call: true,
            modalities: { output: ['text'] }, limit: { context: 128000, output: 65536 }, status: 'deprecated',
            release_date: '2025-09-29',
          },
          'deepseek-flash': {
            id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', tool_call: true,
            modalities: { output: ['text'] }, limit: { context: 1000000, output: 393216 },
            release_date: '2026-09-10',
          },
          'deepseek-v4-pro': {
            id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tool_call: true,
            modalities: { output: ['text'] }, limit: { context: 1000000, output: 393216 },
            release_date: '2026-08-12',
          },
          'deepseek-embed': {
            id: 'deepseek-embed', name: 'DeepSeek Embed', tool_call: false,
            modalities: { output: ['text'] }, limit: { context: 8192, output: 1024 },
          },
        },
      },
    });

    expect(providers.deepseek?.models.map((model) => model.id)).toEqual([
      'deepseek-flash', 'deepseek-v4-pro', 'my-private-model',
    ]);
    expect(providers.deepseek?.defaultModel).toBe('deepseek-flash');
    expect(providers.deepseek?.models[0]).toMatchObject({
      name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxOutput: 393216,
    });
  });

  it('preserves user selected defaults and user provided model entries', () => {
    const providers = {
      deepseek: provider('private-default', [
        { id: 'private-default', name: 'Private', contextWindow: 32768, maxOutput: 4096 },
      ]),
    };
    applyModelsDevCatalog(providers, { deepseek: new Set(['deepseek-chat']) }, {
      deepseek: {
        name: 'DeepSeek',
        models: {
          'deepseek-flash': {
            id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', tool_call: true,
            modalities: { output: ['text'] }, limit: { context: 1000000, output: 393216 },
            release_date: '2026-09-10',
          },
        },
      },
    });
    expect(providers.deepseek?.defaultModel).toBe('private-default');
    expect(providers.deepseek?.models.map((model) => model.id)).toEqual(['deepseek-flash', 'private-default']);
  });

  it('preserves user overrides for a bundled model ID and its configured default', () => {
    const providers = {
      deepseek: provider('deepseek-chat', [
        { id: 'deepseek-chat', name: 'My DeepSeek Alias', contextWindow: 64000, maxOutput: 2048 },
      ]),
    };
    applyModelsDevCatalog(providers, { deepseek: new Set(['deepseek-chat']) }, {
      deepseek: {
        name: 'DeepSeek',
        models: {
          'deepseek-flash': {
            id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', tool_call: true,
            modalities: { output: ['text'] }, limit: { context: 1000000, output: 393216 },
            release_date: '2026-09-10',
          },
        },
      },
    }, {
      configuredModelIds: { deepseek: new Set(['deepseek-chat']) },
      configuredDefaultModels: { deepseek: 'deepseek-chat' },
    });
    expect(providers.deepseek?.defaultModel).toBe('deepseek-chat');
    expect(providers.deepseek?.models).toEqual([
      expect.objectContaining({ id: 'deepseek-flash' }),
      expect.objectContaining({ id: 'deepseek-chat', name: 'My DeepSeek Alias' }),
    ]);
  });
});
