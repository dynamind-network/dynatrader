import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWelcomeMessage } from '../src/ui/utils/chatHelpers.js';

describe('prompt defaults', () => {
  const sectionsPath = join(__dirname, '../src/prompts/sections.ts');
  const builderPath = join(__dirname, '../src/prompts/builder.ts');
  const chatHelpersPath = join(__dirname, '../src/ui/utils/chatHelpers.ts');
  const sections = readFileSync(sectionsPath, 'utf-8');
  const builder = readFileSync(builderPath, 'utf-8');
  const chatHelpers = readFileSync(chatHelpersPath, 'utf-8');

  it('describes DynaMind as a general-purpose agent assistant', () => {
    expect(sections).toContain('general-purpose coding and agent assistant');
    expect(builder).toContain('general-purpose coding and agent assistant');
  });

  it('does not frame the default prompt as trading-only', () => {
    expect(sections).not.toContain('quantitative analyst and trading assistant');
    expect(builder).not.toContain('quantitative analyst and trading assistant');
    expect(sections).not.toContain('trading assistant');
    expect(builder).not.toContain('trading assistant');
  });

  it('keeps domain-specific sections optional and neutral by default', () => {
    expect(sections).toContain('## Domain Guidelines');
    expect(sections).toContain('## Safety Guidelines');
    expect(sections).toContain('## Context Snapshot');
    expect(builder).toContain("trading_rules: { name: 'trading_rules', enabled: false }");
    expect(builder).toContain("risk_management: { name: 'risk_management', enabled: false }");
    expect(builder).toContain(
      "market_context: { name: 'market_context', enabled: false, dynamic: true }"
    );
  });

  it('starts with general-purpose onboarding copy', () => {
    expect(chatHelpers).toContain('AI Harness');
    expect(chatHelpers).toContain('workspace agents');
    expect(chatHelpers).toContain('Ready to work. What would you like to explore?');
    expect(chatHelpers).not.toContain('AI Trading Terminal');
    expect(chatHelpers).not.toContain('Ready to trade');
  });

  it('renders configured subagents in the welcome message when available', () => {
    const message = createWelcomeMessage([
      { name: 'researcher' },
      { name: 'writer' },
      { name: 'planner' },
      { name: 'extra' },
    ]);

    expect(message.content).toContain('workspace agents: @researcher, @writer, @planner');
    expect(message.content).not.toContain('@extra');
  });
});
