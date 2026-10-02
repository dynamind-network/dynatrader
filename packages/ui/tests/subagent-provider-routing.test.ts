import { describe, expect, it } from "vitest";
import { registerSpawnAgentTools, SubagentRegistry } from "../src/agents/subagent.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("subagent provider routing", () => {
  it("preserves the full provider map for subagent dispatch", () => {
    const toolRegistry = new ToolRegistry();
    const subagentRegistry = new SubagentRegistry({
      projectDir: ".dynamind/agents",
      globalDir: ".dynamind/agents",
    });

    registerSpawnAgentTools(toolRegistry, {
      apiKeys: {
        deepseek: "deepseek-key",
        openai: "openai-key",
      },
      model: "deepseek-chat",
      subagentRegistry,
    });

    const tool = toolRegistry.get("spawn_agent") as {
      apiKeys?: Record<string, string>;
    };

    expect(tool.apiKeys).toEqual({
      deepseek: "deepseek-key",
      openai: "openai-key",
    });
  });
});
