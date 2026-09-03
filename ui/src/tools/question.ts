import { z } from 'zod';
import { BaseTool } from './base-tool.js';
import type {
  QuestionOption,
  QuestionPrompt,
  ToolExecutionContext,
  ToolResult,
} from '../core/types.js';

const questionOptionSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
});

const questionSchema = z.object({
  question: z.string().min(1),
  options: z.array(questionOptionSchema).min(2).max(5),
  defaultValue: z.string().optional(),
  allowCustomText: z.boolean().optional(),
});

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const resolveChoice = (prompt: QuestionPrompt, answer: string | null): QuestionOption | null => {
  if (!answer) {
    if (prompt.defaultValue) {
      const byDefault = prompt.options.find(
        (option) =>
          normalize(option.value) === normalize(prompt.defaultValue ?? '') ||
          normalize(option.label) === normalize(prompt.defaultValue ?? '')
      );
      if (byDefault) return byDefault;
    }
    return prompt.options[0] ?? null;
  }

  const normalized = normalize(answer);
  const byValue = prompt.options.find((option) => normalize(option.value) === normalized);
  if (byValue) return byValue;

  const byLabel = prompt.options.find((option) => normalize(option.label) === normalized);
  if (byLabel) return byLabel;

  const numeric = Number.parseInt(answer.trim(), 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
    return prompt.options[numeric - 1] ?? null;
  }

  // If custom text is allowed and no option matched, return custom text as result
  if (prompt.allowCustomText) {
    return { label: answer, value: answer };
  }

  return null;
};

export class QuestionTool extends BaseTool {
  name = 'question';
  description = 'Prompt the user with a multiple-choice question and return the selected option.';
  isDestructive = false;
  readOnly = true;
  canRunInParallel = false;

  inputSchema = {
    type: 'object' as const,
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user',
      },
      options: {
        type: 'array',
        description: '2-4 mutually exclusive answer choices',
        items: {
          type: 'object',
          description: 'A single selectable answer choice',
          properties: {
            label: { type: 'string', description: 'Short visible label' },
            value: { type: 'string', description: 'Returned answer value' },
            description: {
              type: 'string',
              description: 'Optional explanation for the choice',
            },
          },
          required: ['label', 'value'],
        },
      },
      defaultValue: {
        type: 'string',
        description: 'Optional default answer value if the user submits empty input',
      },
      allowCustomText: {
        type: 'boolean',
        description: 'If true, shows "Other" as option 5 and allows user to type custom text',
      },
    },
    required: ['question', 'options'],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const parsed = questionSchema.safeParse(input);
    if (!parsed.success) {
      return this.error('Invalid question input');
    }

    const { question, options, defaultValue, allowCustomText } = parsed.data;
    const prompt: QuestionPrompt = { question, options, defaultValue, allowCustomText };
    const selectedValue = context.askQuestion ? await context.askQuestion(prompt) : null;

    if (selectedValue === null && context.askQuestion) {
      return this.error('Question was cancelled by the user');
    }

    const choice = resolveChoice(prompt, selectedValue);

    if (!choice) {
      return this.error('Question was cancelled or no valid option was selected');
    }

    return this.success(`Selected: ${choice.label} (${choice.value})`, {
      kind: 'question',
      question: prompt.question,
      selected: choice,
    });
  }
}
