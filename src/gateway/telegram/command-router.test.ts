import { describe, it, expect } from "vitest";
import { CommandRouter } from "./command-router";

describe("CommandRouter", () => {
  function makeRouter() {
    const router = new CommandRouter();
    router.register({
      command: "start",
      description: "Start the bot",
      handler: async () => "Welcome!",
    });
    router.register({
      command: "help",
      description: "Show help",
      handler: async () => "Help text",
    });
    router.register({
      command: "echo",
      description: "Echo args",
      aliases: ["say", "repeat"],
      handler: async (ctx) => `Echo: ${ctx.args.join(" ")}`,
    });
    router.register({
      command: "admin",
      description: "Admin only",
      adminOnly: true,
      handler: async () => "Secret admin stuff",
    });
    return router;
  }

  describe("handle", () => {
    it("routes /command to the correct handler", async () => {
      const router = makeRouter();
      const result = await router.handle(1, "/start", 100, "user", 1);
      expect(result).toBe("Welcome!");
    });

    it("returns null for messages without leading /", async () => {
      const router = makeRouter();
      const result = await router.handle(1, "hello", 100, "user", 1);
      expect(result).toBeNull();
    });

    it("returns null for unknown commands", async () => {
      const router = makeRouter();
      const result = await router.handle(1, "/unknown", 100, "user", 1);
      expect(result).toBeNull();
    });

    it("passes args to the handler", async () => {
      const router = makeRouter();
      const result = await router.handle(1, "/echo hello world", 100, "user", 1);
      expect(result).toBe("Echo: hello world");
    });

    it("matches aliases", async () => {
      const router = makeRouter();
      const r1 = await router.handle(1, "/say foo", 100, "user", 1);
      expect(r1).toBe("Echo: foo");
      const r2 = await router.handle(1, "/repeat bar", 100, "user", 1);
      expect(r2).toBe("Echo: bar");
    });

    it("blocks admin-only commands for non-admin users", async () => {
      const router = makeRouter();
      const result = await router.handle(1, "/admin", 100, "user", 1);
      expect(result).toBe("You don't have permission to use this command.");
    });

    it("handles handler errors gracefully", async () => {
      const router = new CommandRouter();
      router.register({
        command: "fail",
        description: "Fails",
        handler: async () => {
          throw new Error("boom");
        },
      });
      const result = await router.handle(1, "/fail", 100, "user", 1);
      expect(result).toContain("Error executing");
    });
  });

  describe("register / unregister", () => {
    it("can unregister a command", async () => {
      const router = makeRouter();
      router.unregister("help");
      const result = await router.handle(1, "/help", 100, "user", 1);
      expect(result).toBeNull();
    });

    it("unregister removes aliases", async () => {
      const router = makeRouter();
      router.unregister("echo");
      const result = await router.handle(1, "/say foo", 100, "user", 1);
      expect(result).toBeNull();
    });
  });

  describe("getHelpText", () => {
    it("lists registered commands", () => {
      const router = makeRouter();
      const help = router.getHelpText();
      expect(help).toContain("/start");
      expect(help).toContain("/help");
      expect(help).toContain("/echo");
      expect(help).toContain("[admin]");
    });
  });

  describe("getCommands", () => {
    it("returns command list for setMyCommands", () => {
      const router = makeRouter();
      const cmds = router.getCommands();
      expect(cmds).toContainEqual({ command: "start", description: "Start the bot" });
      expect(cmds).toContainEqual({ command: "help", description: "Show help" });
    });
  });
});