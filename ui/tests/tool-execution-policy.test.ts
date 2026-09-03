import { describe, expect, it } from "vitest";
import type { ToolExecutionContext, ToolResult } from "../src/core/types.js";
import { BaseTool } from "../src/tools/base-tool.js";
import { ToolExecutionPolicy } from "../src/tools/tool-execution-policy.js";

class StubTool extends BaseTool {
  name = "stub";
  description = "stub";
  inputSchema = {
    type: "object" as const,
    properties: {},
    required: [],
  };
  isDestructive = false;

  async execute(): Promise<ToolResult> {
    return { success: true, output: "ok" };
  }
}

const context: ToolExecutionContext = {
  workingDirectory: process.cwd(),
  conversationId: "test",
  isSubagent: false,
};

describe("ToolExecutionPolicy", () => {
  it("auto-approves read-only tools in auto_edit mode", async () => {
    const tool = new StubTool();
    tool.readOnly = true;
    tool.canRunInParallel = true;

    const decision = await new ToolExecutionPolicy().evaluateApproval(
      tool,
      {},
      context,
      "auto_edit",
    );

    expect(decision.requiresApproval).toBe(false);
  });

  it("still requires approval for external-state mutations in auto_edit mode", async () => {
    const tool = new StubTool();
    tool.mutatesExternalState = true;
    tool.requiresApproval = true;

    const decision = await new ToolExecutionPolicy().evaluateApproval(
      tool,
      {},
      context,
      "auto_edit",
    );

    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toContain("external state");
  });

  it("honors tool-specific confirmation reasons", async () => {
    class ConfirmTool extends StubTool {
      override async shouldConfirmExecute(): Promise<string | null> {
        return "Needs explicit confirmation";
      }
    }

    const decision = await new ToolExecutionPolicy().evaluateApproval(
      new ConfirmTool(),
      {},
      context,
      "yolo",
    );

    expect(decision.requiresApproval).toBe(false);
  });
});
