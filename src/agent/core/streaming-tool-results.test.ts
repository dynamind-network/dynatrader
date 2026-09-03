/**
 * Tests for Streaming Tool Results utilities
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CollectToolProgress,
  createToolProgressEvent,
  type ToolProgressEvent,
} from "./streaming-tool-results";
import type { ModelStreamChunk } from "@dyna/contracts";

describe("createToolProgressEvent", () => {
  it("creates a correct ModelStreamChunk for running status", () => {
    const chunk = createToolProgressEvent("call_123", "get_price", "running", 0);

    expect(chunk.type).toBe("tool_progress");
    expect(chunk.toolProgress).toBeDefined();
    expect(chunk.toolProgress!.toolCallId).toBe("call_123");
    expect(chunk.toolProgress!.toolName).toBe("get_price");
    expect(chunk.toolProgress!.status).toBe("running");
    expect(chunk.toolProgress!.elapsedMs).toBe(0);
    expect(chunk.toolProgress!.message).toBeUndefined();
  });

  it("creates a correct ModelStreamChunk for completed status", () => {
    const chunk = createToolProgressEvent(
      "call_456",
      "place_order",
      "completed",
      1234,
      "Order placed successfully",
    );

    expect(chunk.type).toBe("tool_progress");
    expect(chunk.toolProgress).toBeDefined();
    expect(chunk.toolProgress!.toolCallId).toBe("call_456");
    expect(chunk.toolProgress!.toolName).toBe("place_order");
    expect(chunk.toolProgress!.status).toBe("completed");
    expect(chunk.toolProgress!.elapsedMs).toBe(1234);
    expect(chunk.toolProgress!.message).toBe("Order placed successfully");
  });

  it("creates a correct ModelStreamChunk for error status", () => {
    const chunk = createToolProgressEvent(
      "call_789",
      "get_balance",
      "error",
      567,
      "Insufficient permissions",
    );

    expect(chunk.type).toBe("tool_progress");
    expect(chunk.toolProgress!.toolName).toBe("get_balance");
    expect(chunk.toolProgress!.status).toBe("error");
    expect(chunk.toolProgress!.elapsedMs).toBe(567);
    expect(chunk.toolProgress!.message).toBe("Insufficient permissions");
  });

  it("returns a valid ModelStreamChunk compatible type", () => {
    const chunk = createToolProgressEvent("call_1", "tool_a", "running", 0);
    // Should be assignable to ModelStreamChunk
    const msgs: ModelStreamChunk[] = [chunk];
    expect(msgs[0].type).toBe("tool_progress");
  });
});

describe("CollectToolProgress", () => {
  let collector: CollectToolProgress;

  beforeEach(() => {
    collector = new CollectToolProgress();
  });

  it("collects progress events and returns them as an array", () => {
    const event: ToolProgressEvent = {
      toolCallId: "call_001",
      toolName: "get_price",
      status: "running",
      elapsedMs: 0,
    };

    collector.record(event);
    const events = collector.getEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it("handles tool_start then tool_complete flow", () => {
    collector.record({
      toolCallId: "call_002",
      toolName: "place_order",
      status: "running",
      elapsedMs: 0,
    });

    collector.record({
      toolCallId: "call_002",
      toolName: "place_order",
      status: "completed",
      elapsedMs: 1500,
      message: "Order filled",
    });

    const events = collector.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].status).toBe("running");
    expect(events[1].status).toBe("completed");
    expect(events[1].elapsedMs).toBe(1500);
  });

  it("handles tool_start then tool_error flow", () => {
    collector.record({
      toolCallId: "call_003",
      toolName: "get_balance",
      status: "running",
      elapsedMs: 0,
    });

    collector.record({
      toolCallId: "call_003",
      toolName: "get_balance",
      status: "error",
      elapsedMs: 250,
      message: "API timeout",
    });

    const events = collector.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].status).toBe("running");
    expect(events[1].status).toBe("error");
    expect(events[1].message).toBe("API timeout");
  });

  it("reports elapsed time increasing over multiple calls", () => {
    const toolCallId = "call_004";
    const toolName = "analyze_data";

    collector.record({ toolCallId, toolName, status: "running", elapsedMs: 0 });
    collector.record({ toolCallId, toolName, status: "running", elapsedMs: 500 });
    collector.record({ toolCallId, toolName, status: "completed", elapsedMs: 1200 });

    const events = collector.getEvents();
    expect(events[0].elapsedMs).toBe(0);
    expect(events[1].elapsedMs).toBe(500);
    expect(events[2].elapsedMs).toBe(1200);
  });

  it("returns empty array when no progress recorded", () => {
    const events = collector.getEvents();
    expect(events).toEqual([]);
  });

  it("clear() resets all collected events", () => {
    collector.record({
      toolCallId: "call_005",
      toolName: "some_tool",
      status: "running",
      elapsedMs: 0,
    });

    expect(collector.getEvents()).toHaveLength(1);

    collector.clear();
    expect(collector.getEvents()).toEqual([]);
  });

  it("getEvents() returns a copy, not the internal array", () => {
    collector.record({
      toolCallId: "call_006",
      toolName: "test",
      status: "running",
      elapsedMs: 0,
    });

    const events = collector.getEvents();
    events.push({
      toolCallId: "call_fake",
      toolName: "fake",
      status: "completed",
      elapsedMs: 10,
    });

    // Internal should not have been mutated
    expect(collector.getEvents()).toHaveLength(1);
  });
});