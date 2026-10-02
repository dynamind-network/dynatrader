import { describe, it, expect, beforeEach } from 'vitest';
import {
  SubagentRegistry,
  getSubagentRegistry,
  resetSubagentRegistry,
  type AgentPlugin,
} from './plugin-system.js';
import type { SubagentDefinition } from '../core/types.js';

function makeAgent(name: string): SubagentDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: 'You are helpful.',
    tools: [],
    maxTurns: 3,
    canSpawnSubagents: false,
  };
}

beforeEach(() => {
  resetSubagentRegistry();
});

describe('getSubagentRegistry', () => {
  it('returns a singleton and resets', () => {
    const first = getSubagentRegistry();
    expect(getSubagentRegistry()).toBe(first);

    resetSubagentRegistry();
    expect(getSubagentRegistry()).not.toBe(first);
  });
});

describe('SubagentRegistry backed by kernel', () => {
  it('round-trips registered agents through the kernel', async () => {
    const registry = new SubagentRegistry();
    const agent = makeAgent('coder');

    registry.registerAgent(agent);
    await registry.initialize();

    expect(registry.getAgent('coder')).toEqual(agent);
    expect(registry.hasAgent('coder')).toBe(true);
    expect(registry.getAllAgents()).toEqual([agent]);
    expect(registry.getService<SubagentDefinition>('agent.coder')).toEqual(
      agent,
    );
  });

  it('mounts an AgentPlugin and exposes its agents as kernel services', async () => {
    const registry = new SubagentRegistry();
    const research = makeAgent('researcher');
    const writer = makeAgent('writer');

    const plugin: AgentPlugin = {
      name: 'content-team',
      version: '1.0.0',
      async init(reg) {
        reg.registerAgent(research, this.name);
        reg.registerAgent(writer, this.name);
      },
    };

    registry.register(plugin);
    await registry.initialize();

    expect(registry.getAllAgents()).toEqual([research, writer]);
    expect(registry.getService<SubagentDefinition>('agent.researcher')).toEqual(
      research,
    );
    expect(registry.getService<SubagentDefinition>('agent.writer')).toEqual(
      writer,
    );
  });

  it('unregisters an agent and removes it from lookups', async () => {
    const registry = new SubagentRegistry();
    const agent = makeAgent('temp');

    registry.registerAgent(agent);
    await registry.initialize();

    expect(registry.unregisterAgent('temp')).toBe(true);
    expect(registry.getAgent('temp')).toBeUndefined();
    expect(registry.hasAgent('temp')).toBe(false);
    expect(registry.getAllAgents()).toEqual([]);
  });

  it('does not register a new agent when the existing one has higher priority', async () => {
    const registry = new SubagentRegistry();
    const low = makeAgent('dup');
    const high: AgentPlugin = {
      name: 'high',
      version: '1.0.0',
      async init(reg) {
        reg.registerAgent(low, this.name);
      },
    };

    registry.register(high, 90);
    await registry.initialize();

    const override = makeAgent('dup');
    registry.registerAgent(override, 'low-priority-plugin');

    expect(registry.getAgent('dup')).toEqual(low);
  });
});

