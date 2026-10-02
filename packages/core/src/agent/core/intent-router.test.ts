import { describe, expect, it } from 'vitest';
import { filterIntentRouteToRegisteredTools, IntentRouter, restrictToolsForIntent } from './intent-router';

describe('IntentRouter tool guidance', () => {
  it('limits skill inventory requests to the skill catalog tools', () => {
    const router = new IntentRouter();
    const route = router.classify('what skills do you have available?');
    const tools = ['skills_list', 'skill_view', 'glob', 'grep'].map((name) => ({ name }));

    expect(route.intent).toBe('skills');
    expect(restrictToolsForIntent(route, tools).map((tool) => tool.name)).toEqual(['skills_list', 'skill_view']);
  });

  it('routes skill creation through the registered skill manager', () => {
    const route = new IntentRouter().classify('create a skill to parse JSON documents');
    const tools = ['skills_list', 'skill_view', 'skill_manage', 'write', 'edit'].map((name) => ({ name }));

    expect(route.intent).toBe('skills');
    expect(restrictToolsForIntent(route, tools).map((tool) => tool.name)).toEqual(['skills_list', 'skill_view', 'skill_manage']);
  });

  it('names only trading tools registered by the active runtime', () => {
    const route = new IntentRouter().classify('check this market and trade');
    const filtered = filterIntentRouteToRegisteredTools(route, ['node_repl', 'python_repl']);

    expect(filtered.preferredTools).toEqual(['node_repl', 'python_repl']);
    expect(filtered.preferredTools).not.toContain('compile_strategy');
    expect(filtered.preferredTools).not.toContain('execute_order');
  });

  it('routes market and portfolio research through the compact REPL surface', () => {
    const router = new IntentRouter();
    expect(router.classify('get BTC price and RSI').preferredTools).toEqual(['node_repl', 'python_repl']);
    expect(router.classify('check portfolio equity and exposure').preferredTools).toEqual(['node_repl', 'python_repl']);
  });

  it('leaves general guidance empty when the runtime has no registered trading tools', () => {
    const route = new IntentRouter().classify('please trade this');
    const filtered = filterIntentRouteToRegisteredTools(route, []);

    expect(filtered.preferredTools).toEqual([]);
  });
});
