import { getErrorMessage } from '../../utils/index.js';
import { parseJson } from '../../utils/json.js';
import { OpenAICompatibleProvider } from './openai.js';
import { PROVIDERS } from './registry.js';
import type { ModelInfo } from './types.js';

/**
 * LM Studio provider that auto-detects loaded models from the local server.
 */
export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string) {
    super('lmstudio', apiKey);
  }

  /**
   * Query LM Studio's /v1/models endpoint to discover loaded models.
   * Falls back to a generic placeholder if the server is unreachable.
   */
  async detectModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`LM Studio returned ${response.status}`);
      }

      const data = (await response.json()) as {
        data?: Array<{
          id: string;
          object?: string;
          owned_by?: string;
        }>;
      };

      const models = (data.data || [])
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id,
          name: m.id.split('/').pop() || m.id,
          contextWindow: 128000,
          maxOutput: 4096,
        }));

      this.models = models.length > 0 ? models : this.getFallbackModels();
      return this.models;
    } catch (err) {
      console.warn('[LMStudio] Could not detect models:', getErrorMessage(err));
      this.models = this.getFallbackModels();
      return this.models;
    }
  }

  private getFallbackModels(): ModelInfo[] {
    return [
      {
        id: 'local',
        name: 'Local Model (auto-detect)',
        contextWindow: 128000,
        maxOutput: 4096,
      },
    ];
  }
}

/**
 * Global cache for LM Studio detected models to avoid repeated fetches.
 */
let cachedLMStudioModels: ModelInfo[] | null = null;
let lmStudioDetectPromise: Promise<ModelInfo[]> | null = null;

export async function detectLMStudioModels(baseUrl?: string): Promise<ModelInfo[]> {
  if (cachedLMStudioModels) {
    return cachedLMStudioModels;
  }

  if (lmStudioDetectPromise) {
    return lmStudioDetectPromise;
  }

  lmStudioDetectPromise = (async () => {
    const url = baseUrl || PROVIDERS.lmstudio.baseUrl || 'http://localhost:1234/v1';
    try {
      const response = await fetch(`${url}/models`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        data?: Array<{ id: string }>;
      };

      const models = (data.data || [])
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id,
          name: m.id.split('/').pop() || m.id,
          contextWindow: 128000,
          maxOutput: 4096,
        }));

      cachedLMStudioModels =
        models.length > 0
          ? models
          : [{ id: 'local', name: 'Local Model', contextWindow: 128000, maxOutput: 4096 }];
      return cachedLMStudioModels;
    } catch (err) {
      cachedLMStudioModels = [
        {
          id: 'local',
          name: 'Local Model (server unreachable)',
          contextWindow: 128000,
          maxOutput: 4096,
        },
      ];
      return cachedLMStudioModels;
    }
  })();

  return lmStudioDetectPromise;
}

export function getLMStudioCachedModels(): ModelInfo[] | null {
  return cachedLMStudioModels;
}

export function clearLMStudioModelCache(): void {
  cachedLMStudioModels = null;
  lmStudioDetectPromise = null;
}
