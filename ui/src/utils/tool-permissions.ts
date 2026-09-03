/**
 * Tool Permissions Utilities
 * Defines which agents can use which MCP trading tools
 */

import { ToolRegistry } from '../tools/tool-registry.js';

/**
 * Agent type definitions
 */
export type AgentType = 'trader' | 'analyst' | 'researcher' | 'unknown';

/**
 * Permission configuration for each agent type
 */
const AGENT_PERMISSIONS: Record<AgentType, string[]> = {
  trader: [
    'execute_trade',
    'cancel_order',
    'get_positions',
    'get_balance',
    'set_leverage',
    'set_stop_loss',
    'set_take_profit',
    'get_open_orders',
    'get_order_history',
    'get_trade_history',
    'get_market_data',
    'get_order_book',
    'calculate_indicators',
  ],
  analyst: [
    'get_positions',
    'get_balance',
    'get_market_data',
    'get_order_book',
    'get_trade_history',
    'get_order_history',
    'calculate_indicators',
    'web_search',
    'web_fetch',
  ],
  researcher: [
    'get_market_data',
    'get_order_book',
    'get_trade_history',
    'calculate_indicators',
    'web_search',
    'web_fetch',
    'read_file',
    'glob',
    'grep',
  ],
  unknown: [],
};

/**
 * Trading tools that require write permissions
 */
const TRADING_WRITE_TOOLS = [
  'execute_trade',
  'cancel_order',
  'set_leverage',
  'set_stop_loss',
  'set_take_profit',
];

/**
 * Check if an agent can use a specific tool
 */
export function checkToolPermission(agentType: string, toolName: string): boolean {
  const normalizedAgent = normalizeAgentType(agentType);
  const allowedTools = AGENT_PERMISSIONS[normalizedAgent] || [];
  return allowedTools.includes(toolName);
}

/**
 * Normalize agent type string to AgentType
 */
function normalizeAgentType(agentType: string): AgentType {
  const lower = agentType.toLowerCase();
  if (lower === 'trader' || lower === 'trading') return 'trader';
  if (lower === 'analyst' || lower === 'analysis') return 'analyst';
  if (lower === 'researcher' || lower === 'research') return 'researcher';
  return 'unknown';
}

/**
 * Filter tools in registry based on agent permissions
 */
export function filterToolsForAgent(registry: ToolRegistry, agentType: string): ToolRegistry {
  const filtered = new ToolRegistry();
  const allToolNames = registry.getToolNames();

  for (const name of allToolNames) {
    const tool = registry.get(name);
    if (tool && checkToolPermission(agentType, tool.name)) {
      filtered.register(tool);
    }
  }

  return filtered;
}

/**
 * Get list of allowed tools for an agent type
 */
export function getAllowedTools(agentType: string): string[] {
  const normalizedAgent = normalizeAgentType(agentType);
  return AGENT_PERMISSIONS[normalizedAgent] || [];
}

/**
 * Get list of denied tools for an agent type
 */
export function getDeniedTools(agentType: string): string[] {
  const normalizedAgent = normalizeAgentType(agentType);
  const allowed = AGENT_PERMISSIONS[normalizedAgent] || [];

  // All trading tools not in allowed list are denied
  const allTradingTools = [
    'execute_trade',
    'cancel_order',
    'get_positions',
    'get_balance',
    'set_leverage',
    'set_stop_loss',
    'set_take_profit',
    'get_open_orders',
    'get_order_history',
    'get_trade_history',
    'get_market_data',
    'get_order_book',
    'calculate_indicators',
    'web_search',
    'web_fetch',
    'read_file',
    'glob',
    'grep',
  ];

  return allTradingTools.filter((tool) => !allowed.includes(tool));
}

/**
 * Check if tool is a write operation (requires trader agent)
 */
export function isWriteTool(toolName: string): boolean {
  return TRADING_WRITE_TOOLS.includes(toolName);
}

/**
 * Get agent type description
 */
export function getAgentDescription(agentType: string): string {
  const normalizedAgent = normalizeAgentType(agentType);
  switch (normalizedAgent) {
    case 'trader':
      return 'Full trading capabilities - can execute trades and manage positions';
    case 'analyst':
      return 'Read-only analysis - can view positions and calculate indicators';
    case 'researcher':
      return 'Research mode - can access market data and web resources';
    default:
      return 'No permissions granted';
  }
}
