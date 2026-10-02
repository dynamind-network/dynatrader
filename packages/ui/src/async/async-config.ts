/**
 * Async Agent Configuration Types
 * Defines configuration for async execution and task submission
 */

import type { AgentConfig } from '../core/types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { WebhookServerConfig } from './webhook-server.js';
import type { SubagentRegistry } from '../agents/subagent.js';

export interface AsyncAgentConfig {
  apiKeys: Record<string, string>;
  defaultAgentConfig: AgentConfig;
  toolRegistry: ToolRegistry;
  subagentRegistry?: SubagentRegistry;
  workerCount?: number;
  enableWebhookServer?: boolean;
  webhookConfig?: WebhookServerConfig;
  agentResultsDir?: string;
}

export interface TaskOptions {
  priority?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  timeout?: number;
  maxRetries?: number;
  tags?: string[];
  context?: Record<string, unknown>;
}

export default AsyncAgentConfig;

