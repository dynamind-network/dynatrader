import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendGatewayMessage: vi.fn(),
}));

vi.mock("../../../gateway/runtime-gateway", () => ({
  sendGatewayMessage: mocks.sendGatewayMessage,
}));

import { TelegramSendTool } from "./telegram-send-tool";

describe("TelegramSendTool", () => {
  beforeEach(() => {
    mocks.sendGatewayMessage.mockReset();
  });

  it("sends to an explicit Telegram chat ID through the gateway path", async () => {
    mocks.sendGatewayMessage.mockResolvedValue("telegram:123456");
    const tool = new TelegramSendTool();

    const result = await tool.execute({
      tool: "telegram_send",
      args: {
        chatId: "123456",
        message: "status update",
      },
    });

    expect(mocks.sendGatewayMessage).toHaveBeenCalledWith(
      { target: "telegram:123456", message: "status update" },
      undefined,
    );
    expect(result.success).toBe(true);
    expect((result.data as { deliveredTo: string }).deliveredTo).toBe("telegram:123456");
  });

  it("fails closed when message is missing", async () => {
    const tool = new TelegramSendTool();

    const result = await tool.execute({
      tool: "telegram_send",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("message must be a non-empty string");
  });
});
