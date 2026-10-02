/**
 * Dream Cycle — Budget-Aware Memory Injection
 *
 * Injects memory with token budget awareness.
   */

import type { BaseKnowledge } from '../../knowledge/types/base.js';

function estimateTokenCount(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

export interface BudgetConfig {
  totalBudget: number;
  stableBudget: number;
  contextBudget: number;
  volatileBudget: number;
  warningThreshold: number;
}

const DEFAULT_BUDGET: BudgetConfig = {
  totalBudget: 8000,
  stableBudget: 2000,
  contextBudget: 4000,
  volatileBudget: 2000,
  warningThreshold: 0.8,
};

export interface MemorySlot {
  tier: 'stable' | 'context' | 'volatile';
  content: string;
  tokenCount: number;
  priority: number;
  metadata: Record<string, unknown>;
}

export class BudgetAwareInjector {
  private config: BudgetConfig;
  private slots: MemorySlot[] = [];

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
  }

  addSlot(slot: Omit<MemorySlot, 'tokenCount'>): void {
    this.slots.push({
      ...slot,
      tokenCount: estimateTokenCount(slot.content),
    });
  }

  addKnowledge(knowledge: BaseKnowledge, tier: MemorySlot['tier'] = 'context'): void {
    this.addSlot({
      tier,
      content: knowledge.content,
      priority: this.calculatePriority(knowledge),
      metadata: {
        id: knowledge.id,
        kind: knowledge.kind,
        tags: knowledge.tags,
      },
    });
  }

  inject(): string {
    const sorted = this.slots.sort((a, b) => b.priority - a.priority);
    const result: string[] = [];
    const tierTokens: Record<string, number> = { stable: 0, context: 0, volatile: 0 };

    for (const slot of sorted) {
      const tierBudget = this.getTierBudget(slot.tier);
      if (tierTokens[slot.tier] + slot.tokenCount <= tierBudget) {
        result.push(slot.content);
        tierTokens[slot.tier] += slot.tokenCount;
      }
    }

    return result.join('\n\n');
  }

  getUsage(): { used: number; total: number; percentage: number; byTier: Record<string, number> } {
    const byTier: Record<string, number> = { stable: 0, context: 0, volatile: 0 };

    for (const slot of this.slots) {
      byTier[slot.tier] += slot.tokenCount;
    }

    const used = byTier.stable + byTier.context + byTier.volatile;

    return {
      used,
      total: this.config.totalBudget,
      percentage: used / this.config.totalBudget,
      byTier,
    };
  }

  isOverBudget(): boolean {
    return this.getUsage().percentage > this.config.warningThreshold;
  }

  truncateToFit(): string {
    const usage = this.getUsage();
    if (usage.percentage <= this.config.warningThreshold) {
      return this.inject();
    }

    const budgetRatio = this.config.totalBudget * this.config.warningThreshold / usage.used;
    const truncated: string[] = [];

    for (const slot of this.slots.sort((a, b) => b.priority - a.priority)) {
      const truncatedContent = slot.content.substring(0, Math.floor(slot.content.length * budgetRatio));
      truncated.push(truncatedContent);
    }

    return truncated.join('\n\n');
  }

  private getTierBudget(tier: MemorySlot['tier']): number {
    switch (tier) {
      case 'stable': return this.config.stableBudget;
      case 'context': return this.config.contextBudget;
      case 'volatile': return this.config.volatileBudget;
    }
  }

  private calculatePriority(knowledge: BaseKnowledge): number {
    let priority = 0.5;

    if (knowledge.tags.includes('critical')) priority += 0.3;
    if (knowledge.tags.includes('recent')) priority += 0.2;
    if (knowledge.kind === 'trade-decision') priority += 0.15;

    const age = Date.now() - new Date(knowledge.asOf).getTime();
    const daysSinceCreation = age / (1000 * 60 * 60 * 24);
    if (daysSinceCreation < 1) priority += 0.1;
    else if (daysSinceCreation < 7) priority += 0.05;

    return Math.min(1, priority);
  }
}
