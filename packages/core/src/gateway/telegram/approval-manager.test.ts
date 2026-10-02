import { describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "./approval-manager";
import type { TelegramGateway } from "./telegram-gateway";

describe("ApprovalManager text responses", () => {
  it("does not treat /start or command text as approval", () => {
    const resolve = vi.fn();
    const manager = new ApprovalManager({} as TelegramGateway, [123]);
    (manager as any).pendingApprovals.set("pending", {
      id: "pending",
      operation: "trade",
      riskLevel: "high",
      timestamp: new Date(),
      chatId: 123,
      resolve,
    });

    expect(manager.handleTextResponse("/start", 123, 123)).toBe(false);
    expect(manager.handleTextResponse("/start allow once", 123, 123)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect((manager as any).pendingApprovals.size).toBe(1);

    expect(manager.handleTextResponse("allow once", 123, 123)).toBe(true);
    expect(resolve).toHaveBeenCalledWith("once");
    expect((manager as any).pendingApprovals.size).toBe(0);
  });
});
