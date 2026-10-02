import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { getDynamindPath } from '../utils/constants.js';

export interface WorkspaceStrategyTemplate {
  id: string;
  name: string;
  description?: string;
  category?: string;
  backtestEngine?: string;
  backtest?: {
    engine?: string;
  };
}

function getStrategyTemplateDir(): string {
  return getDynamindPath('strategy-templates');
}

export async function listWorkspaceStrategyTemplates(): Promise<WorkspaceStrategyTemplate[]> {
  return listWorkspaceStrategyTemplatesSync();
}

export async function listWorkspaceStrategyTemplateNames(): Promise<string[]> {
  const templates = listWorkspaceStrategyTemplatesSync();
  return templates.map((template) => template.name);
}

export function listWorkspaceStrategyTemplatesSync(): WorkspaceStrategyTemplate[] {
  try {
    const strategyTemplateDir = getStrategyTemplateDir();
    if (!existsSync(strategyTemplateDir)) return [];

    const entries = readdirSync(strategyTemplateDir, { withFileTypes: true });
    const templates: WorkspaceStrategyTemplate[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const filePath = path.join(strategyTemplateDir, entry.name);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<WorkspaceStrategyTemplate>;
        if (!parsed || typeof parsed !== 'object') continue;
        if (typeof parsed.id !== 'string' || !parsed.id.trim()) continue;
        if (typeof parsed.name !== 'string' || !parsed.name.trim()) continue;

        templates.push({
          id: parsed.id.trim(),
          name: parsed.name.trim(),
          description:
            typeof parsed.description === 'string' ? parsed.description.trim() : undefined,
          category: typeof parsed.category === 'string' ? parsed.category.trim() : undefined,
          backtestEngine:
            typeof parsed.backtestEngine === 'string'
              ? parsed.backtestEngine.trim()
              : (() => {
                  const backtest = parsed.backtest as Record<string, unknown> | undefined;
                  return typeof backtest?.engine === 'string' ? backtest.engine.trim() : undefined;
                })(),
        });
      } catch {
        continue;
      }
    }

    return templates.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function resolveWorkspaceBacktestEngine(strategyName: string): string | undefined {
  const normalized = strategyName.trim().toLowerCase();
  if (!normalized) return undefined;

  const config = loadConfigSync();
  const alias = config.strategyEngines?.[normalized]?.trim().toLowerCase();
  if (alias) return alias;

  const template = listWorkspaceStrategyTemplatesSync().find((entry) => {
    const candidates = [entry.id, entry.name, entry.category]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLowerCase());
    return candidates.includes(normalized);
  });

  if (!template?.backtestEngine) return undefined;
  const resolved = template.backtestEngine.trim().toLowerCase();
  return resolved || undefined;
}

function loadConfigSync(): { strategyEngines?: Record<string, string> } {
  const configs = [
    getDynamindPath('config.json'),
    path.join(
      path.resolve(process.env.DYNAMIND_WORKSPACE_DIR || process.cwd()),
      '.dynamind',
      'config.json'
    ),
  ];

  const merged: Record<string, string> = {};

  try {
    for (const configPath of configs) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const strategyEngines = parsed.strategyEngines;
        if (
          !strategyEngines ||
          typeof strategyEngines !== 'object' ||
          Array.isArray(strategyEngines)
        ) {
          continue;
        }
        for (const [key, value] of Object.entries(strategyEngines as Record<string, unknown>)) {
          if (typeof value === 'string' && value.trim()) {
            merged[key.toLowerCase()] = value.trim().toLowerCase();
          }
        }
      } catch {
        continue;
      }
    }
    return { strategyEngines: merged };
  } catch {
    return {};
  }
}

