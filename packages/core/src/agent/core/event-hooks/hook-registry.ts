/**
 * Hook Registry for DynaMind Terminal
 *
 * Manages hook registration, lookup, and lifecycle for all hook events.
 * Supports command, prompt, http, and agent hook types.
 */
import {
  type HookCommand,
  type HookMatcher,
  type HooksSettings,
  type HookEvent,
  type RegisteredHook,
  type HookMatchResult,
  hookEvents,
} from './hook-types.js';

export class HookRegistry {
  private hooks: Map<HookEvent, RegisteredHook[]> = new Map();
  private hookIndex: Map<string, RegisteredHook[]> = new Map();
  private enabled = true;
  private globalDisabledEvents: Set<HookEvent> = new Set();

  constructor(config?: HooksSettings) {
    this.initializeHooks(config);
  }

  private initializeHooks(config?: HooksSettings): void {
    for (const event of hookEvents) {
      this.hooks.set(event, []);
    }

    if (config) {
      this.loadFromConfig(config);
    }
  }

  private loadFromConfig(config: HooksSettings): void {
    for (const [eventStr, matchers] of Object.entries(config)) {
      const event = eventStr as HookEvent;
      if (!hookEvents.includes(event) || !matchers) {
        continue;
      }

      for (const matcherConfig of matchers) {
        const matcher = matcherConfig.matcher || '*';
        const hooks = matcherConfig.hooks || [];

        for (const hook of hooks) {
          this.registerHook({
            id: this.generateHookId(),
            event,
            matcher,
            hook,
            enabled: true,
            priority: 0,
          });
        }
      }
    }
  }

  private generateHookId(): string {
    return `hook_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  registerHook(hook: RegisteredHook): void {
    const eventHooks = this.hooks.get(hook.event);
    if (!eventHooks) {
      return;
    }

    eventHooks.push(hook);
    eventHooks.sort((a, b) => b.priority - a.priority);

    const indexKey = this.getIndexKey(hook.event, hook.matcher);
    const indexHooks = this.hookIndex.get(indexKey) || [];
    indexHooks.push(hook);
    this.hookIndex.set(indexKey, indexHooks);
  }

  unregisterHook(hookId: string): boolean {
    for (const [event, eventHooks] of this.hooks) {
      const index = eventHooks.findIndex((h) => h.id === hookId);
      if (index !== -1) {
        const hook = eventHooks[index];
        eventHooks.splice(index, 1);

        const indexKey = this.getIndexKey(event, hook.matcher);
        const indexHooks = this.hookIndex.get(indexKey) || [];
        const idxIndex = indexHooks.findIndex((h) => h.id === hookId);
        if (idxIndex !== -1) {
          indexHooks.splice(idxIndex, 1);
        }
        return true;
      }
    }
    return false;
  }

  private getIndexKey(event: HookEvent, matcher: string): string {
    return `${event}:${matcher}`;
  }

  matchHooks(
    event: HookEvent,
    toolName?: string,
    input?: Record<string, unknown>
  ): HookMatchResult {
    if (!this.enabled || this.globalDisabledEvents.has(event)) {
      return { hooks: [], totalCount: 0, asyncCount: 0 };
    }

    const eventHooks = this.hooks.get(event) || [];
    const matched: RegisteredHook[] = [];
    let asyncCount = 0;

    for (const hook of eventHooks) {
      if (!hook.enabled) {
        continue;
      }

      const matches = this.matchesPattern(hook.matcher, toolName, input);
      if (matches) {
        matched.push(hook);
        if (hook.hook.type === 'command' && (hook.hook.async || hook.hook.asyncRewake)) {
          asyncCount++;
        }
      }
    }

    return {
      hooks: matched,
      totalCount: matched.length,
      asyncCount,
    };
  }

  private matchesPattern(
    pattern: string,
    toolName?: string,
    input?: Record<string, unknown>
  ): boolean {
    if (!pattern || pattern === '*') {
      return true;
    }

    if (!toolName) {
      return pattern === '*';
    }

    if (pattern.includes('|')) {
      const patterns = pattern.split('|').map((p) => p.trim().toLowerCase());
      return patterns.includes(toolName.toLowerCase());
    }

    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
      return regex.test(toolName);
    }

    return toolName.toLowerCase() === pattern.toLowerCase();
  }

  getHooksForEvent(event: HookEvent): RegisteredHook[] {
    return this.hooks.get(event) || [];
  }

  getAllHooks(): Map<HookEvent, RegisteredHook[]> {
    return new Map(this.hooks);
  }

  enableHook(hookId: string): boolean {
    for (const eventHooks of this.hooks.values()) {
      const hook = eventHooks.find((h) => h.id === hookId);
      if (hook) {
        hook.enabled = true;
        return true;
      }
    }
    return false;
  }

  disableHook(hookId: string): boolean {
    for (const eventHooks of this.hooks.values()) {
      const hook = eventHooks.find((h) => h.id === hookId);
      if (hook) {
        hook.enabled = false;
        return true;
      }
    }
    return false;
  }

  disableEvent(event: HookEvent): void {
    this.globalDisabledEvents.add(event);
  }

  enableEvent(event: HookEvent): void {
    this.globalDisabledEvents.delete(event);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clear(): void {
    for (const eventHooks of this.hooks.values()) {
      eventHooks.length = 0;
    }
    this.hookIndex.clear();
    this.globalDisabledEvents.clear();
  }

  getHookCount(): number {
    let count = 0;
    for (const eventHooks of this.hooks.values()) {
      count += eventHooks.length;
    }
    return count;
  }

  getHookById(hookId: string): RegisteredHook | undefined {
    for (const eventHooks of this.hooks.values()) {
      const hook = eventHooks.find((h) => h.id === hookId);
      if (hook) {
        return hook;
      }
    }
    return undefined;
  }

  listHooks(): Array<{
    id: string;
    event: HookEvent;
    matcher: string;
    type: string;
    enabled: boolean;
  }> {
    const result: Array<{
      id: string;
      event: HookEvent;
      matcher: string;
      type: string;
      enabled: boolean;
    }> = [];

    for (const [event, eventHooks] of this.hooks) {
      for (const hook of eventHooks) {
        result.push({
          id: hook.id,
          event,
          matcher: hook.matcher,
          type: hook.hook.type,
          enabled: hook.enabled,
        });
      }
    }

    return result;
  }
}

let defaultHookRegistry: HookRegistry | null = null;

export function getHookRegistry(config?: HooksSettings): HookRegistry {
  if (!defaultHookRegistry) {
    defaultHookRegistry = new HookRegistry(config);
  }
  return defaultHookRegistry;
}

export function createHookRegistry(config?: HooksSettings): HookRegistry {
  return new HookRegistry(config);
}

