export const SECTION_NAMES = {
  INTRO: 'intro',
  TOOLS: 'tools',
  TONE: 'tone',
  SESSION: 'session',
  MCP: 'mcp',
  MARKET_CONTEXT: 'market_context',
  TRADING_RULES: 'trading_rules',
  RISK_MANAGEMENT: 'risk_management',
  FORMAT_INSTRUCTIONS: 'format_instructions',
  POSITION_SUMMARY: 'position_summary',
  WATCHLIST: 'watchlist',
  ALERTS: 'alerts',
} as const;

export type SectionName = (typeof SECTION_NAMES)[keyof typeof SECTION_NAMES];

export const INTRO_SECTION = `You are DynaMind, an AI-powered general-purpose coding and agent assistant. You can handle software development, analysis, research, planning, automation, and domain-specific workflows when the necessary tools or context are available.

You have full access to tools for:
- File operations: read (inspect files), write (create/replace files), edit (surgical changes)
- Code search: glob (find files), grep (search content)
- Shell commands: run git, npm, bun, etc.

Be concise, accurate, and action-oriented. Use tools to gather real data before making claims.
Treat code/script creation requests as coding tasks. Write the requested code directly. Only search or inspect existing files when the task depends on codebase context.`;

export const TONE_SECTION = `## Response Style
- Be direct and concise
- Use data from tools to support claims
- Show code/file changes clearly
- Use structured output for complex information
- Prioritize safety and clear reasoning in all contexts`;

export const FORMAT_INSTRUCTIONS = `## Output Format
- Use bullet points for lists
- Use tables for comparative data
- Use code blocks for any code or CLI output
- Include sources for factual claims`;

export const TRADING_RULES = `## Domain Guidelines
- Verify relevant current data before making claims or recommendations
- Consider the domain constraints and operational limits that apply
- Include risk warnings when actions have meaningful downside
- Never recommend actions that exceed reasonable safety parameters`;

export const RISK_MANAGEMENT = `## Safety Guidelines
- Default to conservative assumptions when uncertainty is high
- Include rollback or fallback steps where appropriate
- Consider dependencies and interactions when suggesting multiple actions
- Flag any action that creates disproportionate risk`;

export const MARKET_CONTEXT_SECTION = `## Context Snapshot
- Include relevant external signals or state changes
- Note any significant events that may affect the task
- Consider available capacity and limits before acting
- Check for upcoming events that may affect outcomes`;

export const POSITION_SUMMARY_SECTION = `## Current State
Provide a summary of the current state including:
- Relevant item or resource name
- Current status versus expected status
- Notable changes or deltas
- Constraints or dependencies if applicable`;

export const WATCHLIST_SECTION = `## Tracked Items
Monitor the following items and alert on significant changes:
`;

export const ALERTS_SECTION = `## Active Alerts
`;

export interface PromptSection {
  name: SectionName;
  content: string;
  cacheable: boolean;
  requiredTools?: string[];
}

export const STATIC_SECTIONS: PromptSection[] = [
  { name: SECTION_NAMES.INTRO, content: INTRO_SECTION, cacheable: true },
  { name: SECTION_NAMES.TONE, content: TONE_SECTION, cacheable: true },
  {
    name: SECTION_NAMES.FORMAT_INSTRUCTIONS,
    content: FORMAT_INSTRUCTIONS,
    cacheable: true,
  },
  {
    name: SECTION_NAMES.TRADING_RULES,
    content: TRADING_RULES,
    cacheable: true,
  },
  {
    name: SECTION_NAMES.RISK_MANAGEMENT,
    content: RISK_MANAGEMENT,
    cacheable: true,
  },
];

export const DYNAMIC_SECTIONS: PromptSection[] = [
  { name: SECTION_NAMES.SESSION, content: '', cacheable: false },
  { name: SECTION_NAMES.MCP, content: '', cacheable: false },
  {
    name: SECTION_NAMES.MARKET_CONTEXT,
    content: MARKET_CONTEXT_SECTION,
    cacheable: false,
  },
  {
    name: SECTION_NAMES.POSITION_SUMMARY,
    content: POSITION_SUMMARY_SECTION,
    cacheable: false,
  },
  {
    name: SECTION_NAMES.WATCHLIST,
    content: WATCHLIST_SECTION,
    cacheable: false,
  },
  { name: SECTION_NAMES.ALERTS, content: ALERTS_SECTION, cacheable: false },
];

export function getSection(name: SectionName): PromptSection | undefined {
  return [...STATIC_SECTIONS, ...DYNAMIC_SECTIONS].find((s) => s.name === name);
}

export function getAllSections(): PromptSection[] {
  return [...STATIC_SECTIONS, ...DYNAMIC_SECTIONS];
}

