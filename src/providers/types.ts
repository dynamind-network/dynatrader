export interface ProviderConfig {
  name: string;
  displayName: string;
  apiKey: string;
  baseUrl?: string;
  env: string[];
  models: ModelInfo[];
  defaultModel: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

export type ProviderEntry = Omit<ProviderConfig, 'apiKey'>;

export interface CatalogModel {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  hasKey: boolean;
  contextWindow?: number;
  supportsEffort: boolean;
}

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'max'];

export type ResolveModelResult =
  | { ok: true; model: CatalogModel }
  | { ok: false; error: string; suggestions: string[] };
