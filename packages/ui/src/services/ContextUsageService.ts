import type { Message } from '../core/types.js';
import { Compaction } from '../core/compaction.js';
import { PROVIDERS } from '../core/providers.js';
import { getLMStudioCachedModels } from '../core/providers.js';

function getModelInfo(modelId: string) {
  for (const provider of Object.values(PROVIDERS)) {
    const model = provider.models.find((entry) => entry.id === modelId);
    if (model) {
      return model;
    }
  }

  return getLMStudioCachedModels()?.find((entry) => entry.id === modelId) ?? null;
}

export interface ContextUsage {
  used: number;
  total: number;
  percent: number;
  remaining: number;
  level: 'ok' | 'warning' | 'error' | 'critical';
  contextWindow: number;
  estimatedTurnsRemaining: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getMessageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  let text = '';
  for (const block of msg.content) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

export function getContextUsage(messages: Message[], modelId: string): ContextUsage | null {
  const model = getModelInfo(modelId);
  const contextWindow = model?.contextWindow ?? 0;
  const maxOutput = model?.maxOutput ?? 8192;

  if (contextWindow === 0) return null;

  const used = messages.reduce((sum, msg) => sum + estimateTokens(getMessageText(msg)), 0);

  const buffer = 13_000;
  const reserved = Math.min(maxOutput, 32_000) + buffer;
  const total = contextWindow - reserved;
  const remaining = Math.max(0, total - used);
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  const remainingTokens = contextWindow - used;
  let level: ContextUsage['level'] = 'ok';
  if (remainingTokens < 3_000) level = 'critical';
  else if (remainingTokens < 20_000) level = 'error';
  else if (remainingTokens < 50_000) level = 'warning';

  const userTurns = messages.filter((m) => m.role === 'user').length;
  const avgTokensPerTurn = userTurns > 0 ? used / userTurns : 500;
  const estimatedTurnsRemaining = avgTokensPerTurn > 0
    ? Math.floor(remaining / avgTokensPerTurn)
    : 0;

  return {
    used,
    total,
    percent,
    remaining: remainingTokens,
    level,
    contextWindow,
    estimatedTurnsRemaining,
  };
}

export function formatContextUsage(usage: ContextUsage | null): string | null {
  if (!usage) return null;
  return `${usage.percent}%`;
}

