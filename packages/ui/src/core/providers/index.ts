import { AIProvider } from './base-provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai.js';
import { LMStudioProvider, detectLMStudioModels, getLMStudioCachedModels } from './lmstudio.js';
import { NVIDIAProvider } from './nvidia.js';
import { OpenRouterProvider } from './openrouter.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { PROVIDERS } from './registry.js';
import type { ModelInfo } from './types.js';

export { AIProvider } from './base-provider.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAICompatibleProvider } from './openai.js';
export { LMStudioProvider, detectLMStudioModels, getLMStudioCachedModels } from './lmstudio.js';
export { NVIDIAProvider } from './nvidia.js';
export { OpenRouterProvider } from './openrouter.js';
export { GoogleProvider } from './google.js';
export { OllamaProvider } from './ollama.js';
export { appendWithOverlap, appendUniqueToolCall } from './utils.js';
export { mapFinishReason } from './types.js';
export {
  listCatalogModels,
  findModelById,
  providerRequiresApiKey,
  findProviderForModel,
  resolveModelQuery,
  parseEffortLevel,
  modelSupportsEffort,
  isKnownProvider,
  listProviderNames,
  formatProviderStatus,
  EFFORT_LEVELS,
  type CatalogModel,
  type EffortLevel,
  type ResolveModelResult,
} from './catalog.js';
export type {
  ProviderConfig,
  ModelInfo,
  ChatMessage,
  ToolDefinition,
  ChatRequest,
  ToolCall,
  ChatResponse,
} from './types.js';

export { PROVIDERS, reloadProviders, initProvidersFromYAML, refreshModels } from './registry.js';
export { loadProvidersFromYAML, invalidateProvidersCache } from './yaml-loader.js';

const PROVIDER_FACTORIES: Record<string, (apiKey: string) => AIProvider> = {
  anthropic: (key) => new AnthropicProvider(key),
  deepseek: (key) => new OpenAICompatibleProvider('deepseek', key),
  glm: (key) => new OpenAICompatibleProvider('glm', key),
  google: (key) => new GoogleProvider(key),
  lmstudio: (key) => new LMStudioProvider(key || 'not-needed'),
  nvidia: (key) => new NVIDIAProvider(key),
  ollama: (key) => new OllamaProvider(key),
  openai: (key) => new OpenAICompatibleProvider('openai', key),
  openrouter: (key) => new OpenRouterProvider(key),
};

export function createProvider(providerName: string, apiKey: string): AIProvider {
  const factory = PROVIDER_FACTORIES[providerName];
  if (!factory) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(PROVIDER_FACTORIES).join(', ')}`);
  }
  return factory(apiKey);
}

export async function getAllModels(): Promise<Array<{ provider: string; model: ModelInfo }>> {
  const result: Array<{ provider: string; model: ModelInfo }> = [];
  for (const [providerName, provider] of Object.entries(PROVIDERS)) {
    if (providerName === 'lmstudio') {
      // Detect LM Studio models dynamically
      const lmModels = await detectLMStudioModels();
      for (const model of lmModels) {
        result.push({ provider: providerName, model });
      }
      continue;
    }
    for (const model of provider.models) {
      result.push({ provider: providerName, model });
    }
  }
  return result;
}

export function getModelDisplayName(modelId: string): string {
  for (const provider of Object.values(PROVIDERS)) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return model.name;
  }
  const lmModels = getLMStudioCachedModels();
  const lmModel = lmModels?.find((m) => m.id === modelId);
  if (lmModel) return lmModel.name;

  const knownPrefixes: Record<string, string> = {
    claude: 'Claude',
    deepseek: 'DeepSeek',
    gemini: 'Gemini',
    gpt: 'GPT',
  };
  const [prefix, ...parts] = modelId.replace(/-\d{8}$/, '').split(/[-/]/);
  if (!prefix || !knownPrefixes[prefix.toLowerCase()]) return modelId;
  const suffix = parts.map((part) => part[0]!.toUpperCase() + part.slice(1));
  return [knownPrefixes[prefix.toLowerCase()], ...suffix].join(' ');
}


export function resolveDefaultModel(apiKeys: Record<string, string>): string | null {
  for (const [providerName, provider] of Object.entries(PROVIDERS)) {
    // LM Studio is a local provider that does not require an API key
    if (providerName === 'lmstudio') {
      return provider.defaultModel;
    }
    const hasKey = provider.env.some((envVar) => {
      const value = apiKeys[providerName] || process.env[envVar];
      return value && value.trim().length > 0;
    });
    if (hasKey) {
      return provider.defaultModel;
    }
  }
  return null;
}

