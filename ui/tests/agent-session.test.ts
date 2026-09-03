import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createPromptBuilder } from '../src/core/agent-prompts.js';
import type { AgentConfig } from '../src/core/types.js';

function makeConfig(): AgentConfig {
  return {
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'Custom system prompt from config.',
    maxTokens: 4096,
    maxTurns: 20,
    tools: ['read'],
  };
}

describe('Session snapshot plumbing via SessionSnapshotManager', () => {
  it('embeds explicit snapshot text under the session context header', async () => {
    const builder = createPromptBuilder({
      config: makeConfig(),
      sessionManager: { getSnapshotText: () => 'manager text' },
    });

    const result = await builder.buildSystemPrompt([], 'explicit text', makeConfig());

    expect(result).toContain('## Current Session Context');
    expect(result).toContain('explicit text');
  });

  it('does not consult the manager when explicit text is provided', async () => {
    const getSnapshotText = vi.fn(() => 'manager text');
    const builder = createPromptBuilder({
      config: makeConfig(),
      sessionManager: { getSnapshotText },
    });

    await builder.buildSystemPrompt([], 'explicit text', makeConfig());

    expect(getSnapshotText).not.toHaveBeenCalled();
  });

  it('calls the manager when explicit text is empty', async () => {
    const getSnapshotText = vi.fn(() => 'manager text');
    const builder = createPromptBuilder({
      config: makeConfig(),
      sessionManager: { getSnapshotText },
    });

    const result = await builder.buildSystemPrompt([], '', makeConfig());

    expect(getSnapshotText).toHaveBeenCalled();
    expect(result).toContain('manager text');
  });

  it('uses the manager fallback for whitespace text', async () => {
    const getSnapshotText = vi.fn(() => 'whitespace fallback');
    const builder = createPromptBuilder({
      config: makeConfig(),
      sessionManager: { getSnapshotText },
    });

    const result = await builder.buildSystemPrompt([], '   ', makeConfig());

    expect(getSnapshotText).toHaveBeenCalled();
    expect(result).toContain('whitespace fallback');
  });

  it('falls back to the default message when both sources are empty', async () => {
    const builder = createPromptBuilder({
      config: makeConfig(),
      sessionManager: { getSnapshotText: () => '' },
    });

    const result = await builder.buildSystemPrompt([], '', makeConfig());

    expect(result).toContain('No prior session summary available.');
  });

  it('reflects a changed manager snapshot on the next build', async () => {
    let snapshot = 'first snapshot';
    const builder = createPromptBuilder({
      config: makeConfig(),
      sessionManager: { getSnapshotText: () => snapshot },
    });

    const first = await builder.buildSystemPrompt([], '', makeConfig());
    expect(first).toContain('first snapshot');

    snapshot = 'second snapshot';
    const second = await builder.buildSystemPrompt([], '', makeConfig());

    expect(second).toContain('second snapshot');
    expect(second).not.toContain('first snapshot');
  });
});