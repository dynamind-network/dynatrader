import type { ToolCall, ToolResult } from "@dyna/contracts";
import type { EnhancedHookLoader } from "./event-hooks/hook-loader";
import type { HookEvent, HooksManager, HookResult } from "./hooks";
import type { PostTurnHookDeps } from "./post-turn-hooks";

type HookSessionContext = {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  permissionMode?: string;
};

export interface LifecycleHooksConfig {
  programmatic: HooksManager;
  configured?: EnhancedHookLoader;
  postTurn?: (deps: PostTurnHookDeps) => Promise<void>;
}

/** Single AgentCore dispatch facade for programmatic and configured lifecycle hooks. */
export class LifecycleHooks {
  constructor(private readonly config: LifecycleHooksConfig) {}

  run(event: HookEvent, data: unknown): Promise<HookResult> {
    return this.config.programmatic.run(event, data);
  }

  async startSession(context: HookSessionContext): Promise<void> {
    await this.config.configured?.executeSessionStartHooks(context);
  }

  async preTool(call: ToolCall, context: HookSessionContext): Promise<boolean> {
    const programmatic = await this.config.programmatic.run("pre-tool-call", call);
    if (!programmatic.continue) return false;
    if (programmatic.modify && typeof programmatic.modify === "object") {
      call.args = programmatic.modify as Record<string, unknown>;
    }
    if (!this.config.configured) return true;
    const configured = await this.config.configured.executePreToolHook(call.tool, call.args, context);
    if (configured.updatedInput) call.args = configured.updatedInput;
    return !configured.shouldBlock;
  }

  async postTool(call: ToolCall, result: ToolResult, context: HookSessionContext): Promise<void> {
    await this.config.programmatic.run("post-tool-call", { toolCall: call, result });
    if (!this.config.configured) return;
    const payload = { success: result.success, data: result.data, error: result.error, durationMs: result.durationMs };
    if (result.success) {
      await this.config.configured.executePostToolHook(call.tool, call.args, payload, context);
    } else {
      await this.config.configured.executePostToolFailureHook(call.tool, call.args, payload, context);
    }
  }

  async stop(context: HookSessionContext): Promise<void> {
    await this.config.configured?.executeStopHooks(context);
  }

  /** Durable memory sync remains an independent adapter from configured transcript/event hooks. */
  postTurn(deps: PostTurnHookDeps): void {
    if (this.config.postTurn) this.config.postTurn(deps).catch(() => {});
  }
}
