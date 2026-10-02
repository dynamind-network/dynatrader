/**
 * Channel Runtime
 *
 * Manages channel lifecycle, loads manifests from workspace/channels/,
 * validates channel configs, registers adapters, routes messages through
 * the gateway, and enforces permissions and blocked operations.
 */

import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { Gateway, type HealthStatus } from "@dyna/gateway";
import { AuthRuntime } from "@dyna/auth-runtime";
import { AuditTrail } from "@dyna/audit";
import type { PermissionRuntime } from "@dyna/permission-runtime";
import { EventBus, eventBus as defaultEventBus } from "@dyna/event-bus";
import type { ChannelAdapter, ChannelEnvelope } from "@dyna/contracts";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Schema for validating each channel manifest file.
 */
export const ChannelManifestSchema = z.object({
  name: z.string().min(1, "Channel name is required"),
  type: z.enum(["text", "voice", "trading", "control", "alert"], {
    errorMap: () => ({ message: "Channel type must be one of: text, voice, trading, control, alert" }),
  }),
  provider: z.string().min(1, "Channel provider is required"),
  enabled: z.boolean(),
  blocked_operations: z.array(z.string()).default([]),
  config: z.record(z.unknown()).default({}),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelManifest {
  name: string;
  type: "text" | "voice" | "trading" | "control" | "alert";
  provider: string;
  enabled: boolean;
  blocked_operations: string[];
  config: Record<string, unknown>;
}

export type ChannelStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ChannelState {
  manifest: ChannelManifest;
  status: ChannelStatus;
  /** The registered adapter instance (if any). */
  adapter?: ChannelAdapter;
  /** Last error message when status is "error". */
  error?: string;
  startedAt?: Date;
  messageCount: number;
  errorCount: number;
}

export interface ChannelRuntimeOptions {
  /** Absolute path to the workspace root (contains channels/ subdirectory). */
  workspacePath: string;
  gateway: Gateway;
  auth: AuthRuntime;
  audit: AuditTrail;
  permission?: PermissionRuntime;
  eventBus?: EventBus;
}

export interface ChannelCounts {
  total: number;
  running: number;
  stopped: number;
  errored: number;
}

// ---------------------------------------------------------------------------
// ChannelRuntime
// ---------------------------------------------------------------------------

export class ChannelRuntime {
  // DI
  private readonly workspacePath: string;
  private readonly gateway: Gateway;
  private readonly auth: AuthRuntime;
  private readonly audit: AuditTrail;
  private readonly permission?: PermissionRuntime;
  private readonly eventBus: EventBus;

  // State
  private readonly channels = new Map<string, ChannelState>();
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly startedAt: number = Date.now();
  private running = false;

  /** Unsubscribe functions for gateway message handlers. */
  private readonly handlerUnsubs: Array<() => void> = [];

  constructor(options: ChannelRuntimeOptions) {
    this.workspacePath = options.workspacePath;
    this.gateway = options.gateway;
    this.auth = options.auth;
    this.audit = options.audit;
    this.permission = options.permission;
    this.eventBus = options.eventBus ?? defaultEventBus;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the channel runtime:
   * 1. Load channel manifests from workspace/channels/*.channel.json
   * 2. Start all enabled channels
   * 3. Register gateway message handlers for each channel
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    await this.audit.record({
      type: "action",
      actor: "channel-runtime",
      actorType: "system",
      action: "runtime_start",
      resource: "channel-runtime",
      result: "success",
      details: { timestamp: new Date().toISOString() },
    });

    // 1. Load manifests
    const manifests = await this.loadManifests();

    // 2. Pre-populate channel map with all manifests
    for (const manifest of manifests) {
      if (!this.channels.has(manifest.name)) {
        this.channels.set(manifest.name, {
          manifest,
          status: manifest.enabled ? "starting" : "stopped",
          messageCount: 0,
          errorCount: 0,
        });
      }
    }

    // 3. Start all enabled channels
    for (const manifest of manifests) {
      if (manifest.enabled) {
        await this.startChannel(manifest.name);
      }
    }

    await this.eventBus.emitDynamic("channel-runtime", {
      type: "channel_runtime_started",
      payload: { channelCount: manifests.length },
    });

    await this.audit.record({
      type: "action",
      actor: "channel-runtime",
      actorType: "system",
      action: "runtime_loaded",
      resource: "channel-runtime",
      result: "success",
      details: {
        totalManifests: manifests.length,
        enabledCount: manifests.filter((m) => m.enabled).length,
      },
    });
  }

  /**
   * Gracefully stop the channel runtime:
   * 1. Stop all running channels
   * 2. Unregister all gateway handlers
   * 3. Emit shutdown event
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;

    // Stop all running channels
    const stopPromises: Array<Promise<void>> = [];
    for (const [name, state] of this.channels) {
      if (state.status === "running" || state.status === "error") {
        stopPromises.push(this.stopChannel(name));
      }
    }
    await Promise.allSettled(stopPromises);

    // Unregister gateway handlers
    for (const unsub of this.handlerUnsubs) {
      unsub();
    }
    this.handlerUnsubs.length = 0;

    await this.eventBus.emitDynamic("channel-runtime", {
      type: "channel_runtime_stopped",
    });

    await this.audit.record({
      type: "action",
      actor: "channel-runtime",
      actorType: "system",
      action: "runtime_stop",
      resource: "channel-runtime",
      result: "success",
      details: {},
    });
  }

  /**
   * Restart a single channel by name.
   */
  async restart(channelName: string): Promise<void> {
    const state = this.channels.get(channelName);
    if (!state) {
      throw new Error(`Channel "${channelName}" not found`);
    }

    await this.stopChannel(channelName);
    await this.startChannel(channelName);

    await this.eventBus.emitDynamic("channel-runtime", {
      type: "channel_restarted",
      payload: { channel: channelName },
    });
  }

  // -----------------------------------------------------------------------
  // Manifest loading
  // -----------------------------------------------------------------------

  /**
   * Discover and read all *.channel.json files from workspace/channels/.
   * Validates each manifest against the schema and returns the valid ones.
   * Invalid manifests are skipped and audited as errors.
   */
  async loadManifests(): Promise<ChannelManifest[]> {
    const channelsDir = path.join(this.workspacePath, "channels");
    const manifests: ChannelManifest[] = [];

    let entries: string[];
    try {
      entries = await fs.readdir(channelsDir);
    } catch {
      // channels/ directory does not exist — that is acceptable
      await this.audit.record({
        type: "action",
        actor: "channel-runtime",
        actorType: "system",
        action: "load_manifests",
        resource: channelsDir,
        result: "success",
        details: { warning: "channels directory not found", count: 0 },
      });
      return manifests;
    }

    const channelFiles = entries.filter((f) => f.endsWith(".channel.json"));

    for (const file of channelFiles) {
      const filePath = path.join(channelsDir, file);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        const validated = this.validateManifest(parsed);
        manifests.push(validated);

        await this.audit.record({
          type: "action",
          actor: "channel-runtime",
          actorType: "system",
          action: "manifest_loaded",
          resource: `channel-manifest:${validated.name}`,
          result: "success",
          details: { file, channel: validated.name, provider: validated.provider },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.audit.record({
          type: "error",
          actor: "channel-runtime",
          actorType: "system",
          action: "manifest_load_failed",
          resource: `file:${file}`,
          result: "failure",
          details: { error: message, file },
        });
      }
    }

    return manifests;
  }

  /**
   * Validate an untyped object against the channel manifest schema.
   * Returns the validated manifest or throws.
   */
  validateManifest(data: unknown): ChannelManifest {
    const result = ChannelManifestSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid channel manifest: ${issues}`);
    }
    return result.data;
  }

  // -----------------------------------------------------------------------
  // Channel lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start a single channel by name.
   * Looks up its manifest, transitions state, and if an adapter is
   * registered, starts the adapter and wires up gateway message handling.
   */
  async startChannel(name: string): Promise<void> {
    const existing = this.channels.get(name);

    // If there's an existing state with a manifest we can re-use it
    let manifest: ChannelManifest;
    if (existing) {
      manifest = existing.manifest;
    } else {
      // Manifest hasn't been loaded yet — try looking it up from disk
      throw new Error(
        `Channel "${name}" has not been loaded. Call loadManifests() first or ensure a manifest exists.`
      );
    }

    if (existing && existing.status === "running") {
      return;
    }

    const state: ChannelState = {
      manifest,
      status: "starting",
      messageCount: existing?.messageCount ?? 0,
      errorCount: existing?.errorCount ?? 0,
    };
    this.channels.set(name, state);

    try {
      // Find the adapter for this channel's provider
      const adapter = this.adapters.get(manifest.provider);

      if (adapter) {
        state.adapter = adapter;

        // Connect the adapter's dispatch to our routing pipeline
        await adapter.start(async (envelope: ChannelEnvelope) => {
          await this.routeInbound(envelope);
        });

        // Register a gateway message handler for this channel
        const unsub = this.gateway.onMessage(name, async (envelope: ChannelEnvelope) => {
          state.messageCount++;
          await this.eventBus.emitDynamic("channel-runtime", {
            type: "channel_message",
            payload: { channel: name, envelope },
          });
        });
        this.handlerUnsubs.push(unsub);
      }

      state.status = "running";
      state.startedAt = new Date();
      state.error = undefined;
      this.channels.set(name, state);

      await this.eventBus.emitDynamic("channel-runtime", {
        type: "channel_started",
        payload: { channel: name, provider: manifest.provider },
      });

      await this.audit.record({
        type: "action",
        actor: "channel-runtime",
        actorType: "system",
        action: "channel_start",
        resource: `channel:${name}`,
        result: "success",
        details: { provider: manifest.provider },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.status = "error";
      state.error = message;
      state.startedAt = undefined;
      this.channels.set(name, state);

      await this.audit.record({
        type: "error",
        actor: "channel-runtime",
        actorType: "system",
        action: "channel_start_failed",
        resource: `channel:${name}`,
        result: "failure",
        details: { error: message },
      });

      throw err;
    }
  }

  /**
   * Stop a single channel by name.
   */
  async stopChannel(name: string): Promise<void> {
    const state = this.channels.get(name);
    if (!state || state.status === "stopped") {
      return;
    }

    state.status = "stopping";
    this.channels.set(name, state);

    // Note: the adapter lifecycle (disconnect) would be managed here in
    // a production implementation. For now we simply update the state.
    state.status = "stopped";
    state.startedAt = undefined;
    this.channels.set(name, state);

    await this.eventBus.emitDynamic("channel-runtime", {
      type: "channel_stopped",
      payload: { channel: name },
    });

    await this.audit.record({
      type: "action",
      actor: "channel-runtime",
      actorType: "system",
      action: "channel_stop",
      resource: `channel:${name}`,
      result: "success",
      details: {},
    });
  }

  // -----------------------------------------------------------------------
  // Adapter registration
  // -----------------------------------------------------------------------

  /**
   * Register a channel adapter for a specific provider.
   * Multiple channels can share the same provider adapter.
   */
  registerAdapter(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);

    this.eventBus.emitDynamic("channel-runtime", {
      type: "adapter_registered",
      payload: { adapterId: adapter.id },
    });

    this.audit.record({
      type: "action",
      actor: "channel-runtime",
      actorType: "system",
      action: "adapter_registered",
      resource: `adapter:${adapter.id}`,
      result: "success",
      details: {},
    });
  }

  // -----------------------------------------------------------------------
  // Message routing
  // -----------------------------------------------------------------------

  /**
   * Route an inbound message envelope through the gateway pipeline
   * with channel-specific permission and blocked-operations checks.
   *
   * Returns the number of handlers that processed the message.
   */
  async routeInbound(envelope: ChannelEnvelope): Promise<number> {
    if (!this.running) {
      throw new Error("Channel runtime is not running");
    }

    // 1. Look up the channel state
    const state = this.channels.get(envelope.channel);
    if (!state) {
      await this.audit.record({
        type: "error",
        actor: envelope.senderId,
        actorType: "user",
        action: "inbound_message",
        resource: `channel:${envelope.channel}`,
        result: "failure",
        details: { reason: "Unknown channel", envelope },
      });
      throw new Error(`Unknown channel: ${envelope.channel}`);
    }

    if (state.status !== "running") {
      throw new Error(`Channel "${envelope.channel}" is not running (status: ${state.status})`);
    }

    // 2. Check channel-specific blocked operations
    const operation = envelope.metadata?.operation as string | undefined;
    if (operation && state.manifest.blocked_operations.includes(operation)) {
      await this.audit.record({
        type: "permission",
        actor: envelope.senderId,
        actorType: "user",
        action: "inbound_message",
        resource: `channel:${envelope.channel}/operation:${operation}`,
        result: "denied",
        details: {
          reason: `Operation "${operation}" is blocked on channel "${envelope.channel}"`,
          envelope,
        },
      });
      throw new Error(
        `Operation "${operation}" is blocked on channel "${envelope.channel}"`
      );
    }

    // 3. Also check global blocked operations via auth
    if (operation && this.auth.isBlocked(operation)) {
      await this.audit.record({
        type: "permission",
        actor: envelope.senderId,
        actorType: "user",
        action: "inbound_message",
        resource: `operation:${operation}`,
        result: "denied",
        details: { reason: `Operation "${operation}" is globally blocked`, envelope },
      });
      throw new Error(`Operation "${operation}" is globally blocked`);
    }

    // 4. Check channel access via auth
    const access = await this.gateway.checkAccess(envelope.senderId, envelope.channel);
    if (!access.allowed) {
      await this.audit.record({
        type: "permission",
        actor: envelope.senderId,
        actorType: "user",
        action: "inbound_message",
        resource: `channel:${envelope.channel}`,
        result: "denied",
        details: { reason: access.reason, envelope },
      });
      throw new Error(`Access denied: ${access.reason}`);
    }

    // 5. Optional permission runtime check
    if (this.permission) {
      const permCheck = await this.permission.checkPermission({
        actor: envelope.senderId,
        actorType: "user",
        action: operation ?? "channel:message",
        resource: `channel:${envelope.channel}`,
        mode: "research",
      });

      if (!permCheck.allowed) {
        await this.audit.record({
          type: "permission",
          actor: envelope.senderId,
          actorType: "user",
          action: "inbound_message",
          resource: `channel:${envelope.channel}`,
          result: "denied",
          details: { reasons: permCheck.reasons, envelope },
        });
        throw new Error(`Permission denied: ${permCheck.reasons.join("; ")}`);
      }
    }

    // 6. Route through gateway's inbound handler
    const handled = await this.gateway.handleInbound(envelope);

    // 7. Update channel message count
    state.messageCount++;
    this.channels.set(envelope.channel, state);

    // 8. Audit successful routing
    await this.audit.record({
      type: "action",
      actor: envelope.senderId,
      actorType: "user",
      action: "inbound_message_routed",
      resource: `channel:${envelope.channel}`,
      result: "success",
      details: { channel: envelope.channel, handlers: handled },
    });

    return handled;
  }

  // -----------------------------------------------------------------------
  // Health checks
  // -----------------------------------------------------------------------

  /**
   * Return health status for the channel runtime, including per-channel
   * states. Used by the gateway health check endpoint.
   */
  health(): HealthStatus & { channels: ChannelCounts; channelDetails: Array<{ name: string; status: ChannelStatus; provider: string }> } {
    const channelDetails: Array<{ name: string; status: ChannelStatus; provider: string }> = [];
    for (const [name, state] of this.channels) {
      channelDetails.push({ name, status: state.status, provider: state.manifest.provider });
    }

    const counts = this.getChannelCounts();

    const healthStatus: HealthStatus["status"] =
      counts.errored > 0 ? "degraded" : this.running ? "ok" : "down";

    return {
      status: healthStatus,
      uptime: Date.now() - this.startedAt,
      activeConnections: channelDetails.length,
      activeSessions: this.running ? channelDetails.length : 0,
      handlersByChannel: Object.fromEntries(
        channelDetails.map((d) => [d.name, d.status === "running" ? 1 : 0])
      ),
      channels: counts,
      channelDetails,
    };
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Get a channel state by name.
   */
  getChannel(name: string): ChannelState | undefined {
    return this.channels.get(name);
  }

  /**
   * Get all channel states.
   */
  getChannels(): ChannelState[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get running/stopped/errored counts.
   */
  getChannelCounts(): ChannelCounts {
    let running = 0;
    let stopped = 0;
    let errored = 0;

    for (const state of this.channels.values()) {
      if (state.status === "running" || state.status === "starting") {
        running++;
      } else if (state.status === "error") {
        errored++;
      } else {
        stopped++;
      }
    }

    return {
      total: this.channels.size,
      running,
      stopped,
      errored,
    };
  }

  /**
   * Whether the runtime is currently accepting messages.
   */
  isRunning(): boolean {
    return this.running;
  }
}
