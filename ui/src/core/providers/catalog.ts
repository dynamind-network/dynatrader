import { PROVIDERS } from './registry.js';
import { getLMStudioCachedModels } from './lmstudio.js';
import type { ModelInfo } from './types.js';

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'max'];

export interface CatalogModel {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  hasKey: boolean;
  contextWindow?: number;
  supportsEffort: boolean;
}

function providerHasKey(providerName: string, apiKeys: Record<string, string> = {}): boolean {
  if (providerName === 'lmstudio') return true;
  const provider = PROVIDERS[providerName];
  if (!provider) return false;
  if (apiKeys[providerName]?.trim()) return true;
  return provider.env.some((envVar) => {
    const value = process.env[envVar];
    return Boolean(value && value.trim().length > 0);
  });
}

export function modelSupportsEffort(modelId: string, provider?: string): boolean {
  const id = modelId.toLowerCase();
  if (id.includes('reasoner') || id.includes('o3') || id.includes('o4') || id.startsWith('o1')) {
    return true;
  }
  if (id.includes('opus') || id.includes('sonnet-4')) return true;
  if (
    provider === 'anthropic' &&
    (id.includes('claude') || id.includes('sonnet') || id.includes('opus'))
  ) {
    return true;
  }
  return false;
}

export function listCatalogModels(apiKeys: Record<string, string> = {}): CatalogModel[] {
  const items: CatalogModel[] = [];

  for (const [providerName, provider] of Object.entries(PROVIDERS)) {
    const hasKey = providerHasKey(providerName, apiKeys);
    let models: ModelInfo[] = provider.models;

    if (providerName === 'lmstudio') {
      const cached = getLMStudioCachedModels();
      if (cached && cached.length > 0) {
        models = cached;
      }
    }

    for (const model of models) {
      items.push({
        provider: providerName,
        providerName: provider.displayName,
        id: model.id,
        name: model.name,
        hasKey,
        contextWindow: model.contextWindow,
        supportsEffort: modelSupportsEffort(model.id, providerName),
      });
    }
  }

  return items;
}

export function findModelById(
  modelId: string,
  apiKeys: Record<string, string> = {}
): CatalogModel | undefined {
  const needle = modelId.trim().toLowerCase();
  if (!needle) return undefined;
  return listCatalogModels(apiKeys).find((m) => m.id.toLowerCase() === needle);
}

export function listProviderNames(): string[] {
  return Object.keys(PROVIDERS);
}

export function isKnownProvider(name: string): boolean {
  return name.toLowerCase() in PROVIDERS;
}

export function parseEffortLevel(raw: string): EffortLevel | null {
  const v = raw.trim().toLowerCase();
  if (v === 'default' || v === 'off') return 'none';
  if ((EFFORT_LEVELS as string[]).includes(v)) return v as EffortLevel;
  return null;
}

export type ResolveModelResult =
  { ok: true; model: CatalogModel } | { ok: false; error: string; suggestions: string[] };

export function resolveModelQuery(
  query: string,
  apiKeys: Record<string, string> = {}
): ResolveModelResult {
  const q = query.trim();
  if (!q) {
    return { ok: false, error: 'No model specified.', suggestions: [] };
  }

  const catalog = listCatalogModels(apiKeys);
  const lower = q.toLowerCase();

  const exactId = catalog.find((m) => m.id.toLowerCase() === lower);
  if (exactId) return { ok: true, model: exactId };

  const exactName = catalog.find((m) => m.name.toLowerCase() === lower);
  if (exactName) return { ok: true, model: exactName };

  const partial = catalog.filter(
    (m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower)
  );

  if (partial.length === 1) {
    return { ok: true, model: partial[0]! };
  }

  if (partial.length > 1) {
    return {
      ok: false,
      error: `Ambiguous model "${q}". Matches:`,
      suggestions: partial.slice(0, 8).map((m) => `${m.id} (${m.providerName})`),
    };
  }

  const suggestions = catalog
    .filter((m) => m.hasKey)
    .slice(0, 8)
    .map((m) => m.id);

  return {
    ok: false,
    error: `Unknown model "${q}". Use /models to browse, or set by id.`,
    suggestions: suggestions.length > 0 ? suggestions : catalog.slice(0, 8).map((m) => m.id),
  };
}

export function formatProviderStatus(apiKeys: Record<string, string> = {}): string {
  const lines = ['Providers:', ''];
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const hasKey = providerHasKey(name, apiKeys);
    const status = hasKey ? 'connected' : 'no key';
    lines.push(`  ${name.padEnd(12)} ${provider.displayName}  [${status}]`);
  }
  lines.push('');
  lines.push('Usage: /connect <provider>   then paste API key');
  lines.push(`Valid: ${listProviderNames().join(', ')}`);
  return lines.join('\n');
}
