import type { ToolDefinition, ToolRegistry } from '@dyna/contracts';
import type { PluginToolsByProfile, ToolProfile } from '../tools/tool-profiles';
import { getToolsForProfiles } from '../tools/tool-profiles';

/**
 * First-party capabilities exposed through the Node/Python SDK.
 *
 * These are deliberately NOT listed in CORE_TOOLS: the model never sees them as
 * hard-coded tools to call one at a time. It reaches them by writing code in
 * node_repl / python_repl and chaining `sdk.call(...)`, which is what makes
 * multi-step analysis a single turn instead of N tool round-trips.
 *
 * The profile here is an authorization gate, not a direct-exposure list --
 * `getAvailableSdkToolDefinitions` checks membership in the resolved profile
 * set only. `base` is a core profile, so `resolveProfiles` always includes it
 * and these stay reachable in every host.
 *
 * Order execution is intentionally absent. The standalone research runtime
 * refuses it at the host (`validateOrder`), and offering a tool the host will
 * always reject only teaches the model to retry. Note that this is a capability
 * decision, not a sandbox: the REPL kernels are separate child processes with a
 * minimal environment and unrestricted network egress, so they hold no exchange
 * credentials. Execution, if it ever ships, must be brokered by the host with
 * keys it holds -- never handed to a REPL.
 */
export const FIRST_PARTY_SDK_TOOL_CATALOG: Readonly<Record<string, readonly ToolProfile[]>> = {
  market_data: ['base'],
  indicators: ['base'],
  scan_market: ['base'],
  size_position: ['base'],
  backtest: ['base'],
  memory_search: ['memory'],
  memory_write: ['memory'],
  skills_list: ['base'],
  skill_view: ['base'],
  delegate_task: ['multi_agent'],
};

/** SDK exposure comes only from a registered first-party host capability or an enabled plugin declaration. */
export function getAvailableSdkToolDefinitions(
  registry: Pick<ToolRegistry, 'list'>,
  profiles: ToolProfile[],
  pluginToolsByProfile?: PluginToolsByProfile,
): ToolDefinition[] {
  const profileTools = new Set(getToolsForProfiles(profiles, pluginToolsByProfile));
  const activeProfiles = new Set(profiles);
  return registry.list()
    .map((handler) => handler.definition)
    .filter((definition) => {
      const hostProfiles = FIRST_PARTY_SDK_TOOL_CATALOG[definition.name];
      if (hostProfiles) return hostProfiles.some((profile) => activeProfiles.has(profile));
      return definition.sdkCallable === true && profileTools.has(definition.name);
    });
}

export function isAvailableSdkTool(
  registry: Pick<ToolRegistry, 'get' | 'list'>,
  toolName: string,
  profiles: ToolProfile[],
  pluginToolsByProfile?: PluginToolsByProfile,
): boolean {
  return getAvailableSdkToolDefinitions(registry, profiles, pluginToolsByProfile)
    .some((definition) => definition.name === toolName);
}
