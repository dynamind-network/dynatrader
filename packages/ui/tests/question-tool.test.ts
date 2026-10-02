import { describe, expect, it } from "vitest";
import { QuestionTool } from "../src/tools/question.js";

describe("QuestionTool", () => {
  it("returns the selected option from the interactive callback", async () => {
    const tool = new QuestionTool();
    const result = await tool.execute(
      {
        question: "Choose an execution mode",
        options: [
          { label: "Normal", value: "normal" },
          { label: "Auto-approve", value: "auto" },
        ],
      },
      {
        workingDirectory: "/tmp",
        conversationId: "session-test",
        isSubagent: false,
        askQuestion: async () => "2",
      } as any,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Selected: Auto-approve (auto)");
    expect(result.artifacts).toMatchObject({
      kind: "question",
      question: "Choose an execution mode",
      selected: {
        label: "Auto-approve",
        value: "auto",
      },
    });
  });

  it("uses the default option when no callback is available", async () => {
    const tool = new QuestionTool();
    const result = await tool.execute(
      {
        question: "Pick one",
        options: [
          { label: "Primary", value: "primary" },
          { label: "Secondary", value: "secondary" },
        ],
        defaultValue: "secondary",
      },
      {
        workingDirectory: "/tmp",
        conversationId: "session-test",
        isSubagent: false,
      } as any,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Selected: Secondary (secondary)");
  });

  it("fails cleanly when the user cancels the question", async () => {
    const tool = new QuestionTool();
    const result = await tool.execute(
      {
        question: "Choose one",
        options: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
      },
      {
        workingDirectory: "/tmp",
        conversationId: "session-test",
        isSubagent: false,
        askQuestion: async () => null,
      } as any,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/cancelled/i);
  });
});
