export {
  SubagentRegistry,
  SpawnAgentTool,
  executeSpawnedAgent,
  registerSpawnAgentTools,
} from './subagent.js';

export { ValidationAgent, type ValidationSummary } from './validation-agent.js';

export * from './types.js';
export { AgentLoader } from './agent-loader.js';
export { SkillManager } from './skill-manager.js';
export { CommandRegistry } from './command-registry.js';
export {
  SubagentRegistry as PluginSubagentRegistry,
  getSubagentRegistry,
  resetSubagentRegistry,
  discoverAndLoadPlugins,
  PluginKernel,
  PluginDependencyError,
} from './plugin-system.js';
export type {
  AgentPlugin,
  KernelPluginDefinition,
  KernelPluginContext,
} from './plugin-system.js';
