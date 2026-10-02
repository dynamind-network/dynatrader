import { describe, expect, it } from 'vitest';
import { getRegisteredPluginProfiles, getRegisteredPluginToolsByProfile, getToolsForProfiles, resolveProfiles } from './tool-profiles';
import type { PluginToolDeclaration } from './tool-profiles';
import { getProfileTools } from './tool-profiles';

describe('TUI core tool profiles', () => {
  it('exposes progressive skill discovery and memory tools through always-on profiles', () => {
    const tools = getToolsForProfiles(resolveProfiles());

    expect(tools).toContain('skills_list');
    expect(tools).toContain('skill_view');
    expect(tools).toContain('skill_manage');
    expect(tools).toContain('get_tool_result');
    expect(tools).toContain('todo');
    expect(tools).toContain('memory_search');
    expect(tools).toContain('delegate_task');
    expect(tools).toContain('agent_task_list');
    expect(tools).toContain('agent_task_status');
    expect(tools).toContain('agent_task_cancel');
    expect(tools).not.toContain('memory_inventory');
    expect(tools).not.toContain('current_session_transcript');
  });

  it('exposes the compact trading surface and keeps execution explicit', () => {
    const core = getToolsForProfiles(resolveProfiles());
    expect(core).toContain('node_repl');
    expect(core).toContain('python_repl');
    expect(getProfileTools('trading')).toEqual([]);
    expect(getProfileTools('trading')).not.toContain('market_data');
    expect(getProfileTools('trading')).not.toContain('backtest');
  });

  it('only enables plugin profiles backed by registered tools or host capabilities', () => {
    const declarations: PluginToolDeclaration[] = [
      { name: 'custom_market', description: '', category: 'market', inputSchema: {}, handler: 'customMarket', profiles: ['trading'] },
      { name: 'missing_risk', description: '', category: 'risk', inputSchema: {}, handler: 'missingRisk', profiles: ['risk'] },
    ];

    expect(getRegisteredPluginProfiles(declarations, ['custom_market'])).toEqual(['trading']);
    expect(getRegisteredPluginProfiles([], [], ['risk'])).toEqual(['risk']);
    expect(getRegisteredPluginProfiles([], [])).toEqual([]);
    expect(getToolsForProfiles(['trading'], getRegisteredPluginToolsByProfile(declarations, ['custom_market'])))
      .toContain('custom_market');
  });
});
