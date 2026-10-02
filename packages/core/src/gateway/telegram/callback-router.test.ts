import { describe, it, expect } from "vitest";
import { CallbackRouter } from "./callback-router";

describe("CallbackRouter", () => {
  function makeRouter() {
    const router = new CallbackRouter();
    router.register({
      prefix: "page:",
      description: "Page navigation",
      handler: async (ctx) => ({
        text: `Navigated to page ${ctx.payload}`,
        editMessage: `Page ${ctx.payload} content`,
      }),
    });
    router.register({
      prefix: "trade:",
      description: "Trade actions",
      handler: async (ctx) => {
        if (ctx.payload === "confirm") {
          return { text: "Trade confirmed!", showAlert: true };
        }
        return { text: `Trade action: ${ctx.payload}` };
      },
    });
    router.register({
      prefix: "menu:",
      description: "Menu navigation",
      handler: async (ctx) => ({
        editMessage: `Menu: ${ctx.payload}`,
      }),
    });
    return router;
  }

  describe("handle", () => {
    it("matches by prefix and extracts payload", async () => {
      const router = makeRouter();
      const result = await router.handle({
        callbackQueryId: "cq1",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "page:2",
        payload: "",
      });
      expect(result).not.toBeNull();
      expect(result!.text).toBe("Navigated to page 2");
      expect(result!.editMessage).toBe("Page 2 content");
    });

    it("returns null for unregistered prefix", async () => {
      const router = makeRouter();
      const result = await router.handle({
        callbackQueryId: "cq2",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "unknown:foo",
        payload: "",
      });
      expect(result).toBeNull();
    });

    it("routes to the first matching handler", async () => {
      const router = makeRouter();
      const result = await router.handle({
        callbackQueryId: "cq3",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "menu:settings",
        payload: "",
      });
      expect(result).not.toBeNull();
      expect(result!.editMessage).toBe("Menu: settings");
      expect(result!.text).toBeUndefined();
    });

    it("supports showAlert in result", async () => {
      const router = makeRouter();
      const result = await router.handle({
        callbackQueryId: "cq4",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "trade:confirm",
        payload: "",
      });
      expect(result).not.toBeNull();
      expect(result!.text).toBe("Trade confirmed!");
      expect(result!.showAlert).toBe(true);
    });
  });

  describe("register / unregister", () => {
    it("can unregister a handler by prefix", async () => {
      const router = makeRouter();
      router.unregister("page:");
      const result = await router.handle({
        callbackQueryId: "cq5",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "page:2",
        payload: "",
      });
      expect(result).toBeNull();
    });

    it("other handlers still work after unregister", async () => {
      const router = makeRouter();
      router.unregister("page:");
      const result = await router.handle({
        callbackQueryId: "cq6",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "trade:buy",
        payload: "",
      });
      expect(result).not.toBeNull();
      expect(result!.text).toBe("Trade action: buy");
    });
  });

  describe("multiple handlers with overlapping prefixes", () => {
    it("matches first registered handler when prefixes overlap", async () => {
      const router = new CallbackRouter();
      router.register({
        prefix: "page:",
        description: "Page nav",
        handler: async () => ({ text: "page hit" }),
      });
      router.register({
        prefix: "page:detail:",
        description: "Page detail",
        handler: async () => ({ text: "detail hit" }),
      });
      const result = await router.handle({
        callbackQueryId: "cq7",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "page:detail:123",
        payload: "",
      });
      expect(result!.text).toBe("page hit");
    });

    it("handler errors return null gracefully", async () => {
      const router = new CallbackRouter();
      router.register({
        prefix: "fail:",
        description: "Fails",
        handler: async () => {
          throw new Error("boom");
        },
      });
      const result = await router.handle({
        callbackQueryId: "cq8",
        chatId: 1,
        messageId: 10,
        userId: 100,
        data: "fail:test",
        payload: "",
      });
      expect(result).toBeNull();
    });
  });
});