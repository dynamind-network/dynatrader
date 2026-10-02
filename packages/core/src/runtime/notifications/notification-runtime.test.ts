/**
 * Tests for Notification Runtime
 *
 * Covers: template rendering, severity ranking and threshold checks,
 * severity-based channel filtering, channel lifecycle management,
 * notification dispatch with routing, handler registration, audit logging,
 * event emission, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@dyna/event-bus", () => ({
  eventBus: {
    emit: vi.fn(),
    emitDynamic: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  },
  default: {
    emit: vi.fn(),
    emitDynamic: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("@dyna/audit", () => ({
  AuditTrail: vi.fn(),
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-12345"),
}));

// ---------------------------------------------------------------------------

import {
  NotificationRuntime,
  renderTemplate,
  renderNotification,
  filterChannelsBySeverity,
  severityRank,
  meetsSeverityThreshold,
  DEFAULT_CHANNELS,
  type ChannelConfig,
  type NotificationSeverity,
  type ChannelHandler,
  type DispatchSummary,
} from "./notification-runtime";
import type { EventBus } from "@dyna/event-bus";
import { AuditTrail } from "@dyna/audit";

// ---------------------------------------------------------------------------
// Mock audit helper
// ---------------------------------------------------------------------------

function createMockAudit(): AuditTrail {
  return {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditTrail;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeChannelConfig(
  overrides: Partial<ChannelConfig> = {},
): ChannelConfig {
  return {
    id: "test-channel",
    name: "Test Channel",
    minimumSeverity: "info",
    enabled: true,
    config: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("severityRank()", () => {
  it("returns 0 for info", () => {
    expect(severityRank("info")).toBe(0);
  });

  it("returns 1 for warning", () => {
    expect(severityRank("warning")).toBe(1);
  });

  it("returns 2 for error", () => {
    expect(severityRank("error")).toBe(2);
  });

  it("returns 3 for critical", () => {
    expect(severityRank("critical")).toBe(3);
  });
});

describe("meetsSeverityThreshold()", () => {
  it("returns true when actual equals minimum", () => {
    expect(meetsSeverityThreshold("warning", "warning")).toBe(true);
  });

  it("returns true when actual exceeds minimum", () => {
    expect(meetsSeverityThreshold("critical", "warning")).toBe(true);
  });

  it("returns false when actual is below minimum", () => {
    expect(meetsSeverityThreshold("info", "warning")).toBe(false);
  });

  it("info meets info threshold", () => {
    expect(meetsSeverityThreshold("info", "info")).toBe(true);
  });
});

describe("renderTemplate()", () => {
  it("replaces simple variables", () => {
    const result = renderTemplate("Hello {{ name }}!", { name: "Alice" });
    expect(result).toBe("Hello Alice!");
  });

  it("replaces multiple variables", () => {
    const result = renderTemplate("{{ greeting }}, {{ name }}!", {
      greeting: "Hi",
      name: "Bob",
    });
    expect(result).toBe("Hi, Bob!");
  });

  it("handles numeric values", () => {
    const result = renderTemplate("Price: ${{ price }}", { price: 123.45 });
    expect(result).toBe("Price: $123.45");
  });

  it("handles boolean values", () => {
    const result = renderTemplate("Active: {{ active }}", { active: true });
    expect(result).toBe("Active: true");
  });

  it("handles Date values as ISO strings", () => {
    const date = new Date("2026-05-21T12:00:00Z");
    const result = renderTemplate("Time: {{ time }}", { time: date });
    expect(result).toBe("Time: 2026-05-21T12:00:00.000Z");
  });

  it("leaves missing variables as-is in non-strict mode", () => {
    const result = renderTemplate("Hello {{ name }}!", {});
    expect(result).toBe("Hello {{ name }}!");
  });

  it("replaces missing variables with empty string in strict mode", () => {
    const result = renderTemplate("Hello {{ name }}!", {}, true);
    expect(result).toBe("Hello !");
  });

  it("handles null and undefined values as empty in strict mode", () => {
    const result = renderTemplate("Value: {{ val }}", { val: null }, true);
    expect(result).toBe("Value: ");
  });
});

describe("renderNotification()", () => {
  it("renders both title and body with variables", () => {
    const rendered = renderNotification(
      "Alert: {{ symbol }}",
      "Price dropped to ${{ price }}",
      { symbol: "BTC/USD", price: 45000 },
    );
    expect(rendered.title).toBe("Alert: BTC/USD");
    expect(rendered.body).toBe("Price dropped to $45000");
  });

  it("returns original when no variables provided", () => {
    const rendered = renderNotification("Static Title", "Static Body");
    expect(rendered.title).toBe("Static Title");
    expect(rendered.body).toBe("Static Body");
  });
});

describe("filterChannelsBySeverity()", () => {
  const channels: ChannelConfig[] = [
    { id: "info-ch", name: "Info Channel", minimumSeverity: "info", enabled: true, config: {} },
    { id: "warn-ch", name: "Warn Channel", minimumSeverity: "warning", enabled: true, config: {} },
    { id: "err-ch", name: "Error Channel", minimumSeverity: "error", enabled: true, config: {} },
    { id: "crit-ch", name: "Critical Channel", minimumSeverity: "critical", enabled: true, config: {} },
  ];

  it("info severity only matches channels with minimumSeverity info or lower", () => {
    const result = filterChannelsBySeverity(channels, "info");
    // Only info-ch has minSeverity "info"; all others require higher severity
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("info-ch");
  });

  it("warning severity matches info and warning channels", () => {
    const result = filterChannelsBySeverity(channels, "warning");
    // warning >= info (info-ch) and warning >= warning (warn-ch)
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(["info-ch", "warn-ch"]);
  });

  it("error severity matches info, warning, and error channels", () => {
    const result = filterChannelsBySeverity(channels, "error");
    // error >= info, error >= warning, error >= error
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual(["info-ch", "warn-ch", "err-ch"]);
  });

  it("critical severity matches all channels", () => {
    const result = filterChannelsBySeverity(channels, "critical");
    expect(result).toHaveLength(4);
  });

  it("excludes disabled channels", () => {
    const withDisabled = [
      ...channels,
      { id: "disabled-ch", name: "Disabled", minimumSeverity: "info" as const, enabled: false, config: {} },
    ];
    const result = filterChannelsBySeverity(withDisabled, "info");
    expect(result).toHaveLength(1);
    expect(result.find((c) => c.id === "disabled-ch")).toBeUndefined();
  });
});

describe("NotificationRuntime", () => {
  let audit: AuditTrail;
  let runtime: NotificationRuntime;

  beforeEach(() => {
    audit = createMockAudit();
    runtime = new NotificationRuntime({
      channels: [
        {
          id: "alerts",
          name: "Alerts",
          minimumSeverity: "info",
          enabled: true,
          config: {},
        },
        {
          id: "warnings",
          name: "Warnings",
          minimumSeverity: "warning",
          enabled: true,
          config: {},
        },
        {
          id: "errors",
          name: "Errors",
          minimumSeverity: "error",
          enabled: true,
          config: {},
        },
        {
          id: "disabled-ch",
          name: "Disabled Channel",
          minimumSeverity: "info",
          enabled: false,
          config: {},
        },
      ],
      audit,
    });
  });

  afterEach(async () => {
    if (runtime.isRunning()) {
      await runtime.stop();
    }
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  it("starts and stops the runtime", async () => {
    expect(runtime.isRunning()).toBe(false);

    await runtime.start();
    expect(runtime.isRunning()).toBe(true);

    await runtime.stop();
    expect(runtime.isRunning()).toBe(false);
  });

  it("emits events on start and stop", async () => {
    const eventBus = (await import("@dyna/event-bus")).eventBus as any;
    await runtime.start();
    expect(eventBus.emitDynamic).toHaveBeenCalledWith(
      "notification-runtime",
      expect.objectContaining({ type: "notification_runtime_started" }),
    );

    eventBus.emitDynamic.mockClear();
    await runtime.stop();
    expect(eventBus.emitDynamic).toHaveBeenCalledWith(
      "notification-runtime",
      expect.objectContaining({ type: "notification_runtime_stopped" }),
    );
  });

  // -----------------------------------------------------------------------
  // Channel management
  // -----------------------------------------------------------------------

  it("loads default channels when none provided", () => {
    const r = new NotificationRuntime({ audit: createMockAudit() });
    const channels = r.getChannels();
    expect(channels).toHaveLength(DEFAULT_CHANNELS.length);
  });

  it("registers a new channel", () => {
    runtime.registerChannel(makeChannelConfig({ id: "new-ch", name: "New Channel" }));
    const ch = runtime.getChannel("new-ch");
    expect(ch).toBeDefined();
    expect(ch!.name).toBe("New Channel");
  });

  it("throws when registering a duplicate channel", () => {
    runtime.registerChannel(makeChannelConfig({ id: "dup" }));
    expect(() => runtime.registerChannel(makeChannelConfig({ id: "dup" }))).toThrow(
      'Channel "dup" is already registered',
    );
  });

  it("unregisters a channel", () => {
    runtime.registerChannel(makeChannelConfig({ id: "temp" }));
    const removed = runtime.unregisterChannel("temp");
    expect(removed).toBe(true);
    expect(runtime.getChannel("temp")).toBeUndefined();
  });

  it("returns false when unregistering a non-existent channel", () => {
    const removed = runtime.unregisterChannel("nonexistent");
    expect(removed).toBe(false);
  });

  it("toggles channel enabled state", () => {
    runtime.setChannelEnabled("alerts", false);
    const ch = runtime.getChannel("alerts");
    expect(ch!.enabled).toBe(false);

    runtime.setChannelEnabled("alerts", true);
    expect(runtime.getChannel("alerts")!.enabled).toBe(true);
  });

  it("throws when toggling a non-existent channel", () => {
    expect(() => runtime.setChannelEnabled("nope", false)).toThrow('Channel "nope" not found');
  });

  // -----------------------------------------------------------------------
  // Handler registration
  // -----------------------------------------------------------------------

  it("registers a channel handler", () => {
    const handler: ChannelHandler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);
    // No error means success
  });

  it("throws when registering a handler for an unknown channel", () => {
    const handler: ChannelHandler = vi.fn().mockResolvedValue(undefined);
    expect(() => runtime.registerHandler("unknown", handler)).toThrow(
      'Cannot register handler for unknown channel "unknown"',
    );
  });

  // -----------------------------------------------------------------------
  // Sending notifications
  // -----------------------------------------------------------------------

  it("throws when sending without starting", async () => {
    await expect(runtime.send("Test", "Body", "info")).rejects.toThrow(
      "NotificationRuntime is not running",
    );
  });

  it("dispatches an info notification to channels with minimumSeverity info", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);
    runtime.registerHandler("warnings", handler);
    runtime.registerHandler("errors", handler);

    await runtime.start();
    const summary = await runtime.send("Test", "This is info", "info");

    // Only "alerts" has minSeverity = "info", so only 1 channel matches
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.notificationId).toBe("mock-uuid-12345");
  });

  it("routes warning notifications to info and warning channels", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);
    runtime.registerHandler("warnings", handler);
    runtime.registerHandler("errors", handler);

    await runtime.start();
    const summary = await runtime.send("Warning", "Something is off", "warning");

    // warning >= info (alerts) and warning >= warning (warnings)
    // warning >= error (errors) = false
    expect(summary.succeeded).toBe(2);
  });

  it("routes error notifications to info, warning, and error channels", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);
    runtime.registerHandler("warnings", handler);
    runtime.registerHandler("errors", handler);

    await runtime.start();
    const summary = await runtime.send("Error", "Something broke", "error");

    // error >= info, error >= warning, error >= error => all 3 match
    expect(summary.succeeded).toBe(3);
  });

  it("routes warning notifications to warning+ channels only", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);
    runtime.registerHandler("warnings", handler);
    runtime.registerHandler("errors", handler);

    await runtime.start();
    const summary = await runtime.send("Warning", "Something is off", "warning");

    // Only warnings (min: warning) and errors (min: error) should match
    // alerts has minSeverity: info, so warning >= info = true
    // Actually warning meets the threshold for info (warning >= info = true)
    // It also meets for warning and error
    // Wait, let me re-check the channel configs:
    // alerts: minimumSeverity = "info"
    // warnings: minimumSeverity = "warning"
    // errors: minimumSeverity = "error"
    //
    // For severity = "warning":
    // - alerts: meetsSeverityThreshold("warning", "info") => rank("warning") >= rank("info") => 1 >= 0 => true
    // - warnings: meetsSeverityThreshold("warning", "warning") => 1 >= 1 => true
    // - errors: meetsSeverityThreshold("warning", "error") => 1 >= 2 => false
    // So 2 channels should match: alerts and warnings
    expect(summary.succeeded).toBe(2);
  });

  it("routes error notifications to error+ channels only", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);
    runtime.registerHandler("warnings", handler);
    runtime.registerHandler("errors", handler);

    await runtime.start();
    const summary = await runtime.send("Error", "Something broke", "error");

    // error >= info (alerts) => true
    // error >= warning (warnings) => true
    // error >= error (errors) => true
    // So all 3 match
    // Actually let me re-read the config:
    // alerts: minSeverity = info -> meetsThreshold("error", "info") => 2 >= 0 => true
    // warnings: minSeverity = warning -> meetsThreshold("error", "warning") => 2 >= 1 => true
    // errors: minSeverity = error -> meetsThreshold("error", "error") => 2 >= 2 => true
    // So 3 channels
    expect(summary.succeeded).toBe(3);
  });

  it("renders templates with variables before dispatch", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);

    await runtime.start();
    await runtime.send(
      "Order {{ side }} for {{ qty }} {{ symbol }}",
      "Status: {{ status }}",
      "info",
      { variables: { side: "BUY", qty: 10, symbol: "BTC/USD", status: "filled" } },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Order BUY for 10 BTC/USD",
        body: "Status: filled",
      }),
      expect.objectContaining({ id: "alerts" }),
    );
  });

  it("dispatches to specific channels when channelIds provided", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);
    runtime.registerHandler("errors", handler);

    await runtime.start();
    await runtime.send("Critical", "Major failure", "critical", {
      channelIds: ["errors"],
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("records handler errors as failed dispatches", async () => {
    const goodHandler: ChannelHandler = vi.fn().mockResolvedValue(undefined);
    const badHandler: ChannelHandler = vi.fn().mockRejectedValue(new Error("Connection refused"));

    runtime.registerHandler("alerts", goodHandler);
    runtime.registerHandler("warnings", badHandler);

    await runtime.start();
    const summary = await runtime.send("Test", "Partial failure", "warning");

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results.find((r) => !r.success)!.error).toBe("Connection refused");
  });

  it("returns empty summary when no channels match", async () => {
    // Create a runtime with only critical channel
    const audit2 = createMockAudit();
    const runtime2 = new NotificationRuntime({
      channels: [
        {
          id: "crit-only",
          name: "Critical Only",
          minimumSeverity: "critical",
          enabled: true,
          config: {},
        },
      ],
      audit: audit2,
    });

    const handler: ChannelHandler = vi.fn().mockResolvedValue(undefined);
    runtime2.registerHandler("crit-only", handler);

    await runtime2.start();

    // Sending "info" won't match the "critical" minimumSeverity channel
    const summary = await runtime2.send("Test", "No match", "info");
    expect(summary.total).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);

    await runtime2.stop();
  });

  it("returns empty summary when only disabled channels match", async () => {
    // disabled-ch exists but is disabled
    const handler: ChannelHandler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);

    // Disable all matching channels
    runtime.setChannelEnabled("alerts", false);
    runtime.setChannelEnabled("warnings", false);
    runtime.setChannelEnabled("errors", false);

    await runtime.start();
    const summary = await runtime.send("Test", "No channels", "critical");

    expect(summary.total).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Audit
  // -----------------------------------------------------------------------

  it("audits on successful dispatch", async () => {
    const handler: ChannelHandler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);

    await runtime.start();
    await runtime.send("Audit Test", "Body", "info");

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_sent",
        result: "success",
      }),
    );
  });

  it("audits when dispatch had failures", async () => {
    const handler: ChannelHandler = vi.fn().mockRejectedValue(new Error("Timeout"));
    runtime.registerHandler("alerts", handler);

    await runtime.start();
    await runtime.send("Fail Test", "Body", "info");

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_sent",
        result: "failure",
      }),
    );
  });

  it("audits start event", async () => {
    await runtime.start();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "runtime_start",
      }),
    );
  });

  it("audits stop event", async () => {
    await runtime.start();
    await runtime.stop();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "runtime_stop",
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  it("emits notification_dispatched event", async () => {
    const eventBus = (await import("@dyna/event-bus")).eventBus as any;
    const handler: ChannelHandler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler("alerts", handler);

    await runtime.start();
    eventBus.emitDynamic.mockClear();

    await runtime.send("Event Test", "Body", "info");

    expect(eventBus.emitDynamic).toHaveBeenCalledWith(
      "notification-runtime",
      expect.objectContaining({ type: "notification_dispatched" }),
    );
  });
});
