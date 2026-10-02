import { randomUUID } from 'node:crypto';
import type { AgentCore, DelegationRequest } from '../../agent/core/agent-core';
import type { ResolvedManifest, AgentRegistry } from './agent-registry';
import { getToolsForProfiles, resolveAgentProfiles, type PluginToolsByProfile, type ToolProfile } from '../tools/tool-profiles';

const CHILD_CONTROL_TOOLS = new Set(['delegate_task', 'spawn_subagent', 'agent_task_list', 'agent_task_status', 'agent_task_cancel']);

export interface DelegatedAgentResult {
  agent: string;
  session_id: string;
  content: string;
  usage?: unknown;
  duration_ms: number;
}

/** Execute a real multi-turn child chat through AgentCore with a session-local tool allowlist. */
export async function runDelegatedAgent(
  core: AgentCore,
  registry: AgentRegistry,
  loadedPluginProfiles: ToolProfile[],
  request: DelegationRequest,
  pluginToolsByProfile: PluginToolsByProfile = {},
): Promise<DelegatedAgentResult> {
  let manifest: ResolvedManifest;
  if (request.agent?.trim()) {
    manifest = await registry.get(request.agent.trim());
  } else {
    const agents = await registry.getAll();
    const main = agents.find((agent) => agent.type === 'manager' && !agent.reportsTo) ?? agents.find((agent) => agent.type === 'manager');
    if (!main) throw new Error('No default manager agent is configured; specify an agent name.');
    manifest = main;
  }
  if (!manifest.instructions?.trim()) throw new Error(`Agent ${manifest.name} has no instructions configured`);

  const profiles = resolveAgentProfiles(manifest.profiles?.length ? manifest.profiles : ['base'], loadedPluginProfiles);
  const profileTools = new Set(getToolsForProfiles(profiles, pluginToolsByProfile));
  const manifestAllow = Array.isArray(manifest.tools?.allow) ? manifest.tools.allow : [];
  const manifestDeny = new Set(Array.isArray(manifest.tools?.deny) ? manifest.tools.deny : []);
  const allowAllManifestTools = manifestAllow.includes('*') || manifestAllow.includes('all');
  const allowedTools = core.listAvailableTools()
    .map((tool) => tool.name)
    .filter((name) => profileTools.has(name))
    .filter((name) => !CHILD_CONTROL_TOOLS.has(name))
    .filter((name) => !manifestDeny.has(name))
    .filter((name) => allowAllManifestTools || manifestAllow.length === 0 || manifestAllow.includes(name));

  const sessionId = `subagent-${manifest.name}-${randomUUID()}`;
  const startedAt = Date.now();
  const childCore = core.createRestrictedChild(allowedTools);
  const context = request.context && Object.keys(request.context).length
    ? `\n\nParent-provided context:\n${JSON.stringify(request.context, null, 2)}`
    : '';
  const response = await childCore.chat(`${request.task.trim()}${context}`, {
    sessionId,
    systemInstructions: manifest.instructions,
    signal: request.signal,
  });

  const content = typeof response.content === 'string' ? response.content.trim() : '';
  if (!content) throw new Error(`Agent ${manifest.name} completed without a visible result`);
  return {
    agent: manifest.name,
    session_id: sessionId,
    content,
    usage: response.usage,
    duration_ms: Date.now() - startedAt,
  };
}
