import { beforeAll, describe, expect, it } from 'vitest';
import { buildStatusLineText } from '../src/ui/common/StatusLine.js';
import { initProvidersFromYAML } from '../src/core/providers/index.js';

describe('StatusLine', () => {
  beforeAll(async () => {
    await initProvidersFromYAML();
  });

  it('shows the minimal footer model and mode', () => {
    const text = buildStatusLineText({
      executionMode: 'normal',
      currentModel: 'deepseek-chat',
      isProcessing: true,
    });

    expect(text).toContain('NORMAL');
    expect(text).toContain('thinking');
    expect(text).not.toContain('model:');
    expect(text).not.toContain('screen:');
    expect(text).not.toContain('session:');
    expect(text).not.toContain('approvals:');
    expect(text).not.toContain('queued:');
    expect(text).not.toContain('Ctrl+K');
    expect(text).toContain('DeepSeek');
  });

  it('shows AUTO mode label', () => {
    const text = buildStatusLineText({
      executionMode: 'auto-approve',
      currentModel: 'claude-sonnet-4-20250514',
    });
    expect(text).toContain('AUTO');
    expect(text).toContain('Claude Sonnet 4');
  });

  it('shows friendly model name instead of raw id', () => {
    const text = buildStatusLineText({
      executionMode: 'normal',
      currentModel: 'claude-sonnet-4-20250514',
    });
    expect(text).toContain('Claude Sonnet 4');
    expect(text).not.toContain('claude-sonnet-4-20250514');
  });

  it('falls back to raw model id when not in providers', () => {
    const text = buildStatusLineText({
      executionMode: 'normal',
      currentModel: 'unknown-model-xyz',
    });
    expect(text).toContain('unknown-model-xyz');
  });
});
