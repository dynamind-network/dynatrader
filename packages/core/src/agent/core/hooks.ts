/**
 * Hooks System for Agent Lifecycle
 *
 * Allows users to inject custom logic at specific points:
 * pre/post tool calls, pre/post LLM calls, errors, recovery, compaction, session switches.
 */

export type HookEvent =
  | 'pre-tool-call'
  | 'post-tool-call'
  | 'pre-llm-call'
  | 'post-llm-call'
  | 'on-error'
  | 'on-recovery'
  | 'on-compaction'
  | 'on-session-switch';

export interface HookContext {
  event: HookEvent;
  data: unknown;
  timestamp: Date;
}

export interface HookResult {
  continue: boolean;  // false = stop execution
  modify?: unknown;   // modify the data
}

export interface Hook {
  id: string;
  event: HookEvent;
  handler: (context: HookContext) => Promise<HookResult>;
  priority?: number;  // Lower = runs first, default 0
}

export class HooksManager {
  private hooks: Map<HookEvent, Hook[]> = new Map();

  register(hook: Hook): void {
    const list = this.hooks.get(hook.event) ?? [];
    list.push(hook);
    list.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    this.hooks.set(hook.event, list);
  }

  unregister(hookId: string): void {
    for (const [event, list] of this.hooks) {
      const idx = list.findIndex(h => h.id === hookId);
      if (idx >= 0) {
        list.splice(idx, 1);
        if (list.length === 0) this.hooks.delete(event);
        return;
      }
    }
  }

  async run(event: HookEvent, data: unknown): Promise<HookResult> {
    const list = this.hooks.get(event) ?? [];
    if (list.length === 0) return { continue: true };

    let currentData = data;
    for (const hook of list) {
      const context: HookContext = { event, data: currentData, timestamp: new Date() };
      const result = await hook.handler(context);
      if (!result.continue) return { continue: false, modify: result.modify };
      if (result.modify !== undefined) currentData = result.modify;
    }
    return { continue: true, modify: currentData };
  }

  listHooks(): Hook[] {
    return Array.from(this.hooks.values()).flat();
  }

  clear(): void {
    this.hooks.clear();
  }
}
