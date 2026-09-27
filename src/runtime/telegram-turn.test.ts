import { describe, expect, it } from "vitest";
import { buildTelegramChatOptions } from "./telegram-turn";

describe("buildTelegramChatOptions", () => {
  it("enables tools for the Telegram agent loop", () => {
    expect(buildTelegramChatOptions("tg-123")).toEqual({
      sessionId: "tg-123",
      templateName: "dynatrader-conversation",
      allowTools: true,
    });
  });
});
