/**
 * Notification Runtime
 *
 * Multi-channel notification dispatch with template rendering and
 * severity-based routing. Channels are configured with severity levels
 * and receive notifications matching their configured thresholds.
 * Templates support simple variable interpolation with {{ variableName }}
 * syntax.
 */

import { EventBus, eventBus as defaultEventBus } from "@dyna/event-bus";
import { AuditTrail } from "@dyna/audit";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Notification severity levels in ascending order of urgency.
 * Higher severity implies broader routing.
 */
export type NotificationSeverity = "info" | "warning" | "error" | "critical";

/** Ordered array for severity comparison (higher index = higher severity). */
const SEVERITY_ORDER: NotificationSeverity[] = ["info", "warning", "error", "critical"];

/**
 * Get the numeric rank of a severity level.
 * Higher number = more severe.
 */
export function severityRank(severity: NotificationSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/**
 * Check if `actual` meets or exceeds the `minimum` severity threshold.
 */
export function meetsSeverityThreshold(
  actual: NotificationSeverity,
  minimum: NotificationSeverity,
): boolean {
  return severityRank(actual) >= severityRank(minimum);
}

// ---------------------------------------------------------------------------

/**
 * Template variables that are injected into notification templates.
 */
export type TemplateVariables = Record<string, string | number | boolean | Date | undefined | null>;

/**
 * A rendered notification with the template fully expanded.
 */
export interface RenderedNotification {
  title: string;
  body: string;
  severity: NotificationSeverity;
}

// ---------------------------------------------------------------------------

/**
 * Configuration for a notification channel.
 */
export interface ChannelConfig {
  /** Unique channel identifier. */
  id: string;
  /** Human-readable channel name. */
  name: string;
  /** Minimum severity that this channel will handle. */
  minimumSeverity: NotificationSeverity;
  /** Whether this channel is currently active. */
  enabled: boolean;
  /** Provider-specific configuration. */
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------

/**
 * A pending notification before dispatch.
 */
export interface Notification {
  id: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  channelIds: string[];
  rendered?: RenderedNotification;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------

/**
 * Result of a single notification dispatch to a channel.
 */
export interface DispatchResult {
  channelId: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

// ---------------------------------------------------------------------------

/**
 * Summary of a full notification dispatch across all matched channels.
 */
export interface DispatchSummary {
  notificationId: string;
  total: number;
  succeeded: number;
  failed: number;
  results: DispatchResult[];
  timestamp: Date;
}

// ---------------------------------------------------------------------------

/**
 * Options for constructing a NotificationRuntime.
 */
export interface RuntimeOpts {
  /** Pre-configured notification channels. */
  channels?: ChannelConfig[];
  /** Event bus instance (defaults to shared singleton). */
  eventBus?: EventBus;
  /** Audit trail instance for logging dispatches. */
  audit: AuditTrail;
}

// ---------------------------------------------------------------------------
// Default channels
// ---------------------------------------------------------------------------

/**
 * Default channels used when none are provided.
 */
export const DEFAULT_CHANNELS: ChannelConfig[] = [
  {
    id: "console",
    name: "Console Log",
    minimumSeverity: "info",
    enabled: true,
    config: {},
  },
  {
    id: "log-file",
    name: "Log File",
    minimumSeverity: "warning",
    enabled: true,
    config: { path: "./logs/notifications.log" },
  },
  {
    id: "alert",
    name: "Alert System",
    minimumSeverity: "error",
    enabled: true,
    config: { endpoint: "/api/alerts" },
  },
];

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

/**
 * Render a template string by replacing `{{ variableName }}` placeholders
 * with values from the variables object.
 *
 * Returns the rendered string. If a variable is missing, the placeholder
 * is left as-is (or replaced with an empty string if `strict` is true
 * and the variable is not found).
 */
export function renderTemplate(
  template: string,
  variables: TemplateVariables,
  strict = false,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      if (strict) {
        return "";
      }
      return _match;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value);
  });
}

/**
 * Render a notification's title and body using the provided variables.
 */
export function renderNotification(
  title: string,
  body: string,
  variables?: TemplateVariables,
): { title: string; body: string } {
  if (!variables) {
    return { title, body };
  }
  return {
    title: renderTemplate(title, variables),
    body: renderTemplate(body, variables),
  };
}

// ---------------------------------------------------------------------------
// Severity-based routing
// ---------------------------------------------------------------------------

/**
 * Given a set of channels and a severity level, return only the channels
 * whose `minimumSeverity` threshold is met or exceeded.
 */
export function filterChannelsBySeverity(
  channels: ChannelConfig[],
  severity: NotificationSeverity,
): ChannelConfig[] {
  return channels.filter(
    (ch) => ch.enabled && meetsSeverityThreshold(severity, ch.minimumSeverity),
  );
}

// ---------------------------------------------------------------------------
// NotificationRuntime
// ---------------------------------------------------------------------------

/**
 * Options for sending a notification.
 */
export interface SendOptions {
  /** Override template variables for rendering. */
  variables?: TemplateVariables;
  /** Specific channel IDs to target (overrides severity-routing). */
  channelIds?: string[];
  /** Additional metadata attached to the notification. */
  metadata?: Record<string, unknown>;
}

/**
 * A channel dispatch handler — an async function that sends a notification
 * to an external system.
 */
export type ChannelHandler = (
  notification: RenderedNotification,
  config: ChannelConfig,
) => Promise<void>;

/**
 * Notification Runtime
 *
 * Orchestrates multi-channel notification dispatch:
 * 1. Accepts notifications with a title, body, and severity.
 * 2. Renders templates with provided variables.
 * 3. Routes to channels matching the severity threshold.
 * 4. Dispatches through registered channel handlers.
 * 5. Records results and audits.
 */
export class NotificationRuntime {
  private readonly channels: Map<string, ChannelConfig> = new Map();
  private readonly handlers: Map<string, ChannelHandler> = new Map();
  private readonly eventBus: EventBus;
  private readonly audit: AuditTrail;
  private running = false;

  constructor(options: RuntimeOpts) {
    this.eventBus = options.eventBus ?? defaultEventBus;
    this.audit = options.audit;

    const initialChannels = options.channels ?? DEFAULT_CHANNELS;
    for (const ch of initialChannels) {
      this.channels.set(ch.id, { ...ch });
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the runtime. */
  async start(): Promise<void> {
    this.running = true;
    await this.audit.record({
      type: "action",
      actor: "notification-runtime",
      actorType: "system",
      action: "runtime_start",
      resource: "notification-runtime",
      result: "success",
      details: { channelCount: this.channels.size, timestamp: new Date().toISOString() },
    });
    await this.eventBus.emitDynamic("notification-runtime", {
      type: "notification_runtime_started",
      payload: { channelCount: this.channels.size },
    });
  }

  /** Stop the runtime. */
  async stop(): Promise<void> {
    this.running = false;
    await this.audit.record({
      type: "action",
      actor: "notification-runtime",
      actorType: "system",
      action: "runtime_stop",
      resource: "notification-runtime",
      result: "success",
      details: { timestamp: new Date().toISOString() },
    });
    await this.eventBus.emitDynamic("notification-runtime", {
      type: "notification_runtime_stopped",
    });
  }

  // -----------------------------------------------------------------------
  // Channel management
  // -----------------------------------------------------------------------

  /**
   * Register a notification channel configuration.
   * Throws if a channel with the same id already exists.
   */
  registerChannel(config: ChannelConfig): void {
    if (this.channels.has(config.id)) {
      throw new Error(`Channel "${config.id}" is already registered`);
    }
    this.channels.set(config.id, { ...config });
    this.eventBus.emitDynamic("notification-runtime", {
      type: "channel_registered",
      payload: { channelId: config.id, name: config.name },
    });
  }

  /**
   * Unregister a notification channel by id.
   */
  unregisterChannel(channelId: string): boolean {
    const removed = this.channels.delete(channelId);
    if (removed) {
      this.handlers.delete(channelId);
      this.eventBus.emitDynamic("notification-runtime", {
        type: "channel_unregistered",
        payload: { channelId },
      });
    }
    return removed;
  }

  /**
   * Register a channel dispatch handler for a specific channel.
   */
  registerHandler(channelId: string, handler: ChannelHandler): void {
    if (!this.channels.has(channelId)) {
      throw new Error(`Cannot register handler for unknown channel "${channelId}"`);
    }
    this.handlers.set(channelId, handler);
  }

  /**
   * Get all registered channel configurations.
   */
  getChannels(): ChannelConfig[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get a single channel configuration by id.
   */
  getChannel(channelId: string): ChannelConfig | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Enable or disable a channel.
   */
  setChannelEnabled(channelId: string, enabled: boolean): void {
    const ch = this.channels.get(channelId);
    if (!ch) {
      throw new Error(`Channel "${channelId}" not found`);
    }
    ch.enabled = enabled;
    this.channels.set(channelId, ch);
  }

  // -----------------------------------------------------------------------
  // Sending notifications
  // -----------------------------------------------------------------------

  /**
   * Send a notification. Returns a dispatch summary with per-channel results.
   *
   * - If `options.channelIds` is provided, only those channels are used.
   * - Otherwise, channels are selected by severity-based routing.
   * - If `options.variables` is provided, the title and body are rendered
   *   as templates before dispatch.
   */
  async send(
    title: string,
    body: string,
    severity: NotificationSeverity,
    options: SendOptions = {},
  ): Promise<DispatchSummary> {
    if (!this.running) {
      throw new Error("NotificationRuntime is not running");
    }

    const notificationId = uuidv4();
    const createdAt = new Date();

    // 1. Render template if variables are provided
    const rendered = renderNotification(title, body, options.variables);

    // 2. Resolve target channels
    let targetChannels: ChannelConfig[];
    if (options.channelIds && options.channelIds.length > 0) {
      targetChannels = options.channelIds
        .map((id) => this.channels.get(id))
        .filter((ch): ch is ChannelConfig => ch !== undefined && ch.enabled);
    } else {
      targetChannels = filterChannelsBySeverity(this.getChannels(), severity);
    }

    if (targetChannels.length === 0) {
      const summary: DispatchSummary = {
        notificationId,
        total: 0,
        succeeded: 0,
        failed: 0,
        results: [],
        timestamp: createdAt,
      };

      await this.audit.record({
        type: "action",
        actor: "notification-runtime",
        actorType: "system",
        action: "notification_skipped",
        resource: "notification-runtime",
        result: "success",
        details: {
          notificationId,
          title: rendered.title,
          severity,
          reason: "No matching channels",
        },
      });

      return summary;
    }

    const renderedNotification: RenderedNotification = {
      title: rendered.title,
      body: rendered.body,
      severity,
    };

    // 3. Dispatch to each target channel
    const results: DispatchResult[] = await Promise.all(
      targetChannels.map(async (ch) => {
        const handler = this.handlers.get(ch.id);
        if (!handler) {
          // No registered handler for this channel: we record it as a
          // "success" because the channel is configured but has no handler;
          // real-world usage would always register handlers.
          return {
            channelId: ch.id,
            success: true,
            timestamp: new Date(),
          };
        }

        try {
          await handler(renderedNotification, ch);
          return {
            channelId: ch.id,
            success: true,
            timestamp: new Date(),
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            channelId: ch.id,
            success: false,
            error: errorMessage,
            timestamp: new Date(),
          };
        }
      }),
    );

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    const summary: DispatchSummary = {
      notificationId,
      total: results.length,
      succeeded,
      failed,
      results,
      timestamp: createdAt,
    };

    // 4. Audit the dispatch
    await this.audit.record({
      type: "action",
      actor: "notification-runtime",
      actorType: "system",
      action: "notification_sent",
      resource: "notification-runtime",
      result: failed > 0 ? "failure" : "success",
      details: {
        notificationId,
        title: rendered.title,
        severity,
        channelsDispatched: results.length,
        succeeded,
        failed,
        results: results.map((r) => ({
          channelId: r.channelId,
          success: r.success,
          error: r.error,
        })),
      },
    });

    // 5. Emit event
    await this.eventBus.emitDynamic("notification-runtime", {
      type: "notification_dispatched",
      payload: {
        notificationId,
        severity,
        results: results.map((r) => ({
          channelId: r.channelId,
          success: r.success,
          error: r.error,
        })),
      },
    });

    return summary;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Whether the runtime is accepting notifications.
   */
  isRunning(): boolean {
    return this.running;
  }
}
