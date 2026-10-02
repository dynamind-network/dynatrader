import type { ToolCall, ToolResult } from '@dyna/contracts';

/** Stable capability names shared by the Node and Python SDK clients. */
export type DynaSdkMethod =
  | 'market.price' | 'market.candles' | 'market.markets' | 'portfolio.snapshot'
  | 'analysis.indicators' | 'analysis.scan' | 'analysis.size' | 'analysis.backtest'
  | 'trading.proposeOrder' | 'trading.executeOrder'
  | 'memory.search' | 'memory.write' | 'skills.list' | 'skills.view' | 'agents.delegate'
  | 'tools.list' | 'tools.call';

export const DYNA_SDK_METHODS: readonly DynaSdkMethod[] = [
  'market.price', 'market.candles', 'market.markets', 'portfolio.snapshot',
  'analysis.indicators', 'analysis.scan', 'analysis.size', 'analysis.backtest',
  'trading.proposeOrder', 'trading.executeOrder',
  'memory.search', 'memory.write', 'skills.list', 'skills.view', 'agents.delegate',
  'tools.list', 'tools.call',
];

export interface DynaSdkCallContext { sessionId: string; signal?: AbortSignal }
export type DynaSdkToolExecutor = (call: ToolCall, context: DynaSdkCallContext) => Promise<ToolResult>;
export interface DynaSdkInvoker {
  invoke<T = unknown>(method: DynaSdkMethod, params: Record<string, unknown>, context: DynaSdkCallContext): Promise<T>;
}

export interface DynaTraderSdk {
  market: {
    price(symbol: string, timeframe: string): Promise<unknown>;
    candles(symbol: string, timeframe: string, limit?: number): Promise<unknown>;
    markets(): Promise<unknown>;
  };
  portfolio: { snapshot(): Promise<unknown> };
  analysis: {
    indicators(symbol: string, timeframe: string, period?: number): Promise<unknown>;
    scan(timeframe: string, limit?: number): Promise<unknown>;
    size(entry: number, stopLoss: number, equity: number): Promise<unknown>;
    backtest(params: Record<string, unknown>): Promise<unknown>;
  };
  trading: {
    proposeOrder(params: Record<string, unknown>): Promise<unknown>;
    executeOrder(params: Record<string, unknown>): Promise<unknown>;
  };
  memory: {
    search(params: Record<string, unknown>): Promise<unknown>;
    write(params: Record<string, unknown>): Promise<unknown>;
  };
  skills: {
    list(): Promise<unknown>;
    view(skillName: string, resourcePath?: string): Promise<unknown>;
  };
  agents: { delegate(params: Record<string, unknown>): Promise<unknown> };
  /** Discover and invoke plugin tools explicitly marked sdkCallable. */
  tools: {
    list(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
    call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  };
}

/** Session-bound ergonomic SDK. All calls use the same injected host executor and policy path. */
export function createDynaTraderSdk(invoker: DynaSdkInvoker, context: DynaSdkCallContext): DynaTraderSdk {
  const call = (method: DynaSdkMethod, params: Record<string, unknown> = {}) => invoker.invoke(method, params, context);
  return {
    market: {
      price: (symbol, timeframe) => call('market.price', { symbol, timeframe }),
      candles: (symbol, timeframe, limit) => call('market.candles', { symbol, timeframe, limit }),
      markets: () => call('market.markets'),
    },
    portfolio: { snapshot: () => call('portfolio.snapshot') },
    analysis: {
      indicators: (symbol, timeframe, period) => call('analysis.indicators', { symbol, timeframe, period }),
      scan: (timeframe, limit) => call('analysis.scan', { timeframe, limit }),
      size: (entry, stopLoss, equity) => call('analysis.size', { entry, stopLoss, equity }),
      backtest: (params) => call('analysis.backtest', params),
    },
    trading: {
      proposeOrder: (params) => call('trading.proposeOrder', params),
      executeOrder: (params) => call('trading.executeOrder', params),
    },
    memory: {
      search: (params) => call('memory.search', params),
      write: (params) => call('memory.write', params),
    },
    skills: {
      list: () => call('skills.list'),
      view: (skill_name, resource_path) => call('skills.view', { skill_name, resource_path }),
    },
    agents: { delegate: (params) => call('agents.delegate', params) },
    tools: {
      list: () => call('tools.list') as Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>,
      call: (name, args = {}) => call('tools.call', { name, args }),
    },
  };
}

/** Maps SDK methods onto existing handlers; execution is injected so AgentCore can enforce profiles and approvals. */
export function createDynaSdkInvoker(execute: DynaSdkToolExecutor): DynaSdkInvoker {
  return {
    async invoke<T>(method: DynaSdkMethod, params: Record<string, unknown>, context: DynaSdkCallContext): Promise<T> {
      const mapped = method === 'tools.call'
        ? { tool: 'sdk_tool_invoke', args: params }
        : methodToTool(method, params);
      const call: ToolCall = { tool: mapped.tool, args: mapped.args, id: `sdk-${crypto.randomUUID()}` };
      let result: ToolResult;
      result = await execute(call, context);
      if (!result.success) throw new Error(result.error ?? `Dyna SDK call '${method}' failed.`);
      return result.data as T;
    },
  };
}

export function methodToTool(method: DynaSdkMethod, params: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  switch (method) {
    case 'market.price': return { tool: 'market_data', args: { ...params, action: 'price' } };
    case 'market.candles': return { tool: 'market_data', args: { ...params, action: 'ohlcv' } };
    case 'market.markets': return { tool: 'market_data', args: { ...params, action: 'markets' } };
    case 'portfolio.snapshot': return { tool: 'market_data', args: { ...params, action: 'portfolio' } };
    case 'analysis.indicators': return { tool: 'indicators', args: params };
    case 'analysis.scan': return { tool: 'scan_market', args: params };
    case 'analysis.size': return { tool: 'size_position', args: params };
    case 'analysis.backtest': return { tool: 'backtest', args: params };
    case 'trading.proposeOrder': return { tool: 'propose_order', args: params };
    case 'trading.executeOrder': return { tool: 'execute_order', args: params };
    case 'memory.search': return { tool: 'memory_search', args: { action: 'search', ...params } };
    case 'memory.write': return { tool: 'memory_write', args: params };
    case 'skills.list': return { tool: 'skills_list', args: {} };
    case 'skills.view': return { tool: 'skill_view', args: params };
    case 'agents.delegate': return { tool: 'delegate_task', args: params };
    case 'tools.list': return { tool: 'sdk_tools_list', args: {} };
    case 'tools.call': return { tool: 'sdk_tool_invoke', args: params };
  }
}
