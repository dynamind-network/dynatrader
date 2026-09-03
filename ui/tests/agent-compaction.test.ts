import { describe, it, expect, beforeEach } from 'vitest';
import {
  Compaction,
  snipToolResults,
  collapseContext,
  compactionCircuitBreaker,
  resetCompactionCircuitBreaker,
  getCompactionCircuitBreakerState,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  AUTOCOMPACT_BUFFER_TOKENS,
} from '../src/core/compaction.js';
import type { Message, ContentBlock } from '../src/core/types.js';

function mk(role: 'user' | 'assistant', content: string | ContentBlock[]): Message {
  return { role, content };
}

function mkToolResult(length: number): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: '1',
    content: 'x'.repeat(length),
  };
}

beforeEach(() => {
  resetCompactionCircuitBreaker();
});

describe('Compaction constants', () => {
  it('defines the documented budget constants', () => {
    expect(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES).toBe(3);
    expect(AUTOCOMPACT_BUFFER_TOKENS).toBe(13000);
    expect(Compaction.PRUNE_MINIMUM).toBe(20000);
    expect(Compaction.PRUNE_PROTECT).toBe(40000);
  });

  it('estimates tokens as ceil(chars / 4)', () => {
    expect(Compaction.estimateTokens('aaaa')).toBe(1);
    expect(Compaction.estimateTokens('hello world')).toBe(3);
    expect(Compaction.estimateTokens('')).toBe(0);
  });
});

describe('Compaction.getBudgetProjection', () => {
  it('reports zero usage for an empty conversation', () => {
    const projection = Compaction.getBudgetProjection([], 100000);
    expect(projection.currentTokens).toBe(0);
    expect(projection.contextWindow).toBe(100000);
    expect(projection.usagePercent).toBe(0);
    expect(projection.needsCompact).toBe(false);
    expect(projection.tokensUntilCompact).toBe(
      100000 - 8192 - AUTOCOMPACT_BUFFER_TOKENS
    );
  });

  it('projects turns remaining for a small conversation', () => {
    const projection = Compaction.getBudgetProjection(
      [mk('user', 'a'.repeat(100))],
      100000
    );
    expect(projection.currentTokens).toBe(25);
    expect(projection.usagePercent).toBe(0);
    expect(projection.needsCompact).toBe(false);
    expect(projection.tokensUntilCompact).toBe(100000 - 8192 - AUTOCOMPACT_BUFFER_TOKENS - 25);
    expect(projection.estimatedTurnsRemaining).toBeGreaterThan(0);
  });

  it('flags an overflowing context as needing compaction', () => {
    const projection = Compaction.getBudgetProjection(
      [mk('user', 'a'.repeat(400000))],
      20000
    );
    expect(projection.currentTokens).toBe(100000);
    expect(projection.needsCompact).toBe(true);
    expect(projection.tokensUntilCompact).toBe(0);
    expect(projection.estimatedTurnsRemaining).toBe(0);
  });
});

describe('Compaction.isOverflow', () => {
  it('returns false for a zero context window', () => {
    expect(Compaction.isOverflow([mk('user', 'huge'.repeat(1000))], 0)).toBe(false);
  });

  it('returns false for a small conversation in a large window', () => {
    expect(Compaction.isOverflow([mk('user', 'hello')], 100000)).toBe(false);
  });

  it('returns true when the conversation exceeds usable context', () => {
    expect(Compaction.isOverflow([mk('user', 'a'.repeat(400000))], 20000)).toBe(true);
  });
});

describe('Compaction.getWarningLevel', () => {
  it('returns ok when far below the thresholds', () => {
    expect(Compaction.getWarningLevel([mk('user', 'hello')], 100000)).toBe('ok');
  });

  it('returns error when the conversation exceeds the error threshold', () => {
    expect(Compaction.getWarningLevel([mk('user', 'a'.repeat(400000))], 100000)).toBe('error');
  });
});

describe('Compaction.microcompact', () => {
  it('returns messages unchanged when at or under the keep window', () => {
    const messages = Array.from({ length: 8 }, (_, i) => mk('user', `msg-${i}`));
    const result = Compaction.microcompact(messages);
    expect(result).toBe(messages);
  });

  it('keeps the last N messages plus the newest system message', () => {
    const system = mk('user', 'system: follow the instructions');
    const others = Array.from({ length: 9 }, (_, i) => mk('user', `msg-${i + 1}`));
    const result = Compaction.microcompact([system, ...others], 6);
    expect(result).toHaveLength(7);
    expect(result[0].content).toBe('system: follow the instructions');
    expect(result[1].content).toBe('msg-4');
    expect(result[6].content).toBe('msg-9');
  });

  it('keeps only recent messages when no system message exists', () => {
    const messages = Array.from({ length: 10 }, (_, i) => mk('user', `msg-${i + 1}`));
    const result = Compaction.microcompact(messages, 6);
    expect(result).toHaveLength(6);
    expect(result[0].content).toBe('msg-5');
    expect(result[5].content).toBe('msg-10');
  });

  it('detects DynaMind-branded system messages', () => {
    const system = mk('user', 'DynaMind operating system');
    const others = Array.from({ length: 9 }, (_, i) => mk('user', `msg-${i + 1}`));
    const result = Compaction.microcompact([system, ...others], 6);
    expect(result[0].content).toBe('DynaMind operating system');
  });
});

describe('Compaction.reactiveCompact', () => {
  it('strips thinking blocks and drops compacted or pruned messages', () => {
    const messages: Message[] = [
      mk('assistant', [
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 'kept text' },
      ]),
      mk('user', '[Pruned: old message cleared]'),
      { role: 'user', content: 'compacted message', compacted: true },
      mk('user', 'normal message'),
    ];
    const result = Compaction.reactiveCompact(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toEqual([{ type: 'text', text: 'kept text' }]);
    expect(result[1].content).toBe('normal message');
  });

  it('leaves a conversation with no exclusions untouched', () => {
    const messages = [mk('user', 'a'), mk('assistant', 'b'), mk('user', 'c')];
    const result = Compaction.reactiveCompact(messages);
    expect(result).toHaveLength(3);
  });
});

describe('Compaction.prune', () => {
  function prunableConversation(charsPerMsg: number, count: number, trailingUsers = 2): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < count; i++) {
      messages.push(mk('user', `u-${i}`));
      messages.push(mk('assistant', `${String.fromCharCode(97 + i)}`.repeat(charsPerMsg)));
    }
    messages.push(mk('user', 'turn one'));
    messages.push(mk('assistant', 'recent response'));
    messages.push(mk('user', 'turn two'));
    void trailingUsers;
    return messages;
  }

  it('returns 0 and mutates nothing when pruning is disabled', () => {
    const messages = prunableConversation(80000, 3);
    const saved = Compaction.prune({
      messages,
      config: { compaction: { prune: false } },
    });
    expect(saved).toBe(0);
    expect(messages[0].compacted).toBeUndefined();
  });

  it('does not prune when the conversation is below the minimum', () => {
    const messages = prunableConversation(30000, 2);
    const saved = Compaction.prune({ messages });
    expect(saved).toBeLessThanOrEqual(Compaction.PRUNE_MINIMUM);
    expect(messages.every((m) => !m.compacted)).toBe(true);
  });

  it('marks old assistant messages beyond the protected budget as pruned', () => {
    const messages = prunableConversation(80000, 3);
    const saved = Compaction.prune({ messages });

    expect(saved).toBe(60000);
    expect(messages[1].compacted).toBe(true);
    expect(messages[1].content).toBe('[Pruned: old message cleared]');
    expect(messages[0].compacted).toBeUndefined();
    expect(messages[2].compacted).toBeUndefined();
    expect(messages).toHaveLength(9);
  });
});

describe('snipToolResults', () => {
  it('truncates oversized tool results with the snip suffix', () => {
    const messages: Message[] = [mk('assistant', [mkToolResult(10000)])];
    const result = snipToolResults(messages);

    const block = result[0].content as ContentBlock[];
    expect(block[0]).toEqual({
      type: 'tool_result',
      tool_use_id: '1',
      content:
        'x'.repeat(8192) + '\n... [snipped, use read tool for full content]',
    });
  });

  it('leaves small tool results untouched', () => {
    const messages: Message[] = [mk('assistant', [mkToolResult(100)])];
    const result = snipToolResults(messages);
    expect(result[0].content).toEqual([mkToolResult(100)]);
  });

  it('honors a custom maxResultBytes limit', () => {
    const messages: Message[] = [mk('assistant', [mkToolResult(5000)])];
    const result = snipToolResults(messages, 1000);
    const block = result[0].content as ContentBlock[];
    expect(block[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: '1',
      content:
        'x'.repeat(1000) + '\n... [snipped, use read tool for full content]',
    });
  });

  it('leaves string-content messages untouched', () => {
    const messages: Message[] = [mk('user', 'plain'), mk('assistant', 'more')];
    const result = snipToolResults(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
  });

  it('does not alter non-tool_result blocks', () => {
    const text: ContentBlock = { type: 'text', text: 'x'.repeat(20000) };
    const messages: Message[] = [mk('assistant', [text])];
    const result = snipToolResults(messages);
    expect(result[0].content).toEqual([text]);
  });
});

describe('collapseContext', () => {
  it('prepends the newest system message and keeps in-budget messages', () => {
    const system = mk('user', 'system: you are a helpful assistant');
    const messages = [system, mk('user', 'hello'), mk('assistant', 'hi there')];
    const result = collapseContext(messages, 10000);
    expect(result[0].content).toBe('system: you are a helpful assistant');
    expect(result).toHaveLength(4);
  });

  it('archives an overflowing assistant message', () => {
    const messages = [mk('user', 'system: brief'), mk('assistant', 'a'.repeat(20000))];
    const result = collapseContext(messages, 100);
    expect(result[0].content).toBe('system: brief');
    expect(result[1]).toMatchObject({
      role: 'assistant',
      compacted: true,
    });
    expect(result[1].content).toContain('archived');
  });

  it('keeps recent messages within the protected token budget', () => {
    const system = mk('user', 'system: brief');
    const messages = [
      system,
      mk('assistant', 'a'.repeat(80000)),
      mk('user', 'recent user'),
      mk('assistant', 'recent assistant'),
    ];
    const result = collapseContext(messages, 1000);
    expect(result[0].content).toBe('system: brief');
    expect(result[result.length - 1].content).toBe('recent assistant');
  });
});

describe('Compaction.summarize', () => {
  it('returns an empty summary when there are fewer than 2 messages', async () => {
    const result = await Compaction.summarize({
      messages: [mk('user', 'only one')],
      modelId: 'test-model',
      apiKeys: {},
      providerName: 'anthropic',
    });
    expect(result).toEqual({ summary: '', tokensSaved: 0 });
  });

  it('throws when no API key is available', async () => {
    await expect(
      Compaction.summarize({
        messages: [mk('user', 'a'), mk('assistant', 'b')],
        modelId: 'test-model',
        apiKeys: {},
        providerName: 'anthropic',
      })
    ).rejects.toThrow('No API key for provider: anthropic');
    expect(getCompactionCircuitBreakerState()).toBe(0);
  });
});

describe('circuit breaker', () => {
  it('tracks consecutive compaction failures', () => {
    expect(compactionCircuitBreaker.isOpen()).toBe(false);
    compactionCircuitBreaker.recordFailure();
    compactionCircuitBreaker.recordFailure();
    expect(compactionCircuitBreaker.isOpen()).toBe(false);
    compactionCircuitBreaker.recordFailure();
    expect(compactionCircuitBreaker.isOpen()).toBe(true);
  });

  it('recordSuccess resets the failure count', () => {
    compactionCircuitBreaker.recordFailure();
    compactionCircuitBreaker.recordFailure();
    compactionCircuitBreaker.recordFailure();
    expect(compactionCircuitBreaker.isOpen()).toBe(true);
    compactionCircuitBreaker.recordSuccess();
    expect(compactionCircuitBreaker.isOpen()).toBe(false);
    expect(getCompactionCircuitBreakerState()).toBe(0);
  });

  it('skips compaction and resolves empty when the breaker is open', async () => {
    compactionCircuitBreaker.recordFailure();
    compactionCircuitBreaker.recordFailure();
    compactionCircuitBreaker.recordFailure();

    const messages = [mk('user', 'a'), mk('assistant', 'b')];
    const result = await Compaction.compact({
      messages,
      modelId: 'test-model',
      contextWindow: 100000,
      apiKeys: {},
      providerName: 'anthropic',
    });

    expect(result).toEqual({
      compactedMessages: messages,
      summary: '',
      tokensSaved: 0,
      prunedCount: 0,
    });
  });

  it('rejects and records failures through Compaction.compact', async () => {
    await expect(
      Compaction.compact({
        messages: [mk('user', 'a'), mk('assistant', 'b')],
        modelId: 'test-model',
        contextWindow: 100000,
        apiKeys: {},
        providerName: 'anthropic',
      })
    ).rejects.toThrow('No API key for provider: anthropic');
    expect(getCompactionCircuitBreakerState()).toBe(1);
  });
});