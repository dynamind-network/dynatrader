export { BaseTool, MCPTool } from './base-tool.js';
export { SkillTool } from './skill.js';
export { ToolRegistry, globalToolRegistry } from './tool-registry.js';
export { ToolExecutionPolicy } from './tool-execution-policy.js';

export { ReadFileTool } from './read-file.js';
export { WriteFileTool, EditFileTool } from './write-file.js';
export { QuestionTool } from './question.js';
export { ShellTool } from './shell.js';
export { GlobTool, GrepTool } from './search.js';
export { WebSearchTool } from './web-search.js';
export { WebFetchTool } from './web-fetch.js';
export { WatchlistTool, AlertsTool } from './watchlist-alerts.js';
export {
  getBuiltinToolPlugin,
  getBuiltinToolPlugins,
  registerPluginTools,
  type ToolPluginDef,
  type BuiltinToolPluginId,
} from './plugins.js';

import * as path from 'path';
import { ToolRegistry } from './tool-registry.js';
import { ReadFileTool } from './read-file.js';
import { WriteFileTool, EditFileTool } from './write-file.js';
import { QuestionTool } from './question.js';
import { ShellTool } from './shell.js';
import { GlobTool, GrepTool } from './search.js';
import { WebSearchTool } from './web-search.js';
import { WebFetchTool } from './web-fetch.js';
import { WatchlistTool, AlertsTool } from './watchlist-alerts.js';
import { getProjectDirectory } from '../utils/project-detection.js';
import { loadPluginSettingsSync } from '../config/settings.js';
import { registerPluginTools } from './plugins.js';

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  registry.register(new QuestionTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new ShellTool());
  registry.register(new WebSearchTool());
  registry.register(new WebFetchTool());
  registry.register(new WatchlistTool());
  registry.register(new AlertsTool());
}

export function createDefaultToolRegistry(projectDir?: string): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);

  const actualProjectDir = projectDir || getProjectDirectory();
  const absoluteProjectDir = path.resolve(actualProjectDir);
  registerPluginTools(registry, loadPluginSettingsSync(absoluteProjectDir));
  registry.initializeMCP(absoluteProjectDir);

  return registry;
}

