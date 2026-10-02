/**
 * Bootstrap Ritual Template
 *
 * Conversational template for agent initial setup. The agent uses this during
 * bootstrap to have a friendly Q&A with the user to establish workspace
 * identity, soul, operating style, and communication preferences.
 *
 * This template is loaded by the agent when BOOTSTRAP.md exists in the workspace.
 * The agent walks through the questions one at a time, updating workspace files
 * (IDENTITY.md, USER.md, SOUL.md)
 * as it learns about the workspace preferences.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BootstrapCompletionCheck {
  (messages: Message[]): boolean;
}

export interface BootstrapRitualTemplate {
  name: string;
  systemPrompt: string;
  completionCheck: BootstrapCompletionCheck;
  followUpPrompts: string[];
  completionSummary: string;
}

// ---------------------------------------------------------------------------
// Completion tracking
// ---------------------------------------------------------------------------

interface BootstrapAreas {
  name: boolean;
  operatingStyle: boolean;
  tradingStyle: boolean;
  communicationStyle: boolean;
}

/**
 * Check if the conversation has covered all required bootstrap areas.
 * Looks for keywords and patterns that indicate each area was discussed.
 */
const checkCompletion: BootstrapCompletionCheck = (messages: Message[]): boolean => {
  const allContent = messages
    .map(m => m.content.toLowerCase())
    .join(' ');

  const areas: BootstrapAreas = {
    name: false,
    operatingStyle: false,
    tradingStyle: false,
    communicationStyle: false,
  };

  // Check for name discussion
  if (
    allContent.includes('call you') ||
    allContent.includes('your name') ||
    allContent.includes('what should') ||
    allContent.includes('i\'ll call you') ||
    allContent.includes('name is')
  ) {
    areas.name = true;
  }

  // Check for operating style discussion
  if (
    allContent.includes('style') ||
    allContent.includes('approach') ||
    allContent.includes('risk') ||
    allContent.includes('decision') ||
    allContent.includes('prioritize') ||
    allContent.includes('objective') ||
    allContent.includes('rule')
  ) {
    areas.operatingStyle = true;
  }

  // Check for trading style discussion
  if (
    allContent.includes('trading') ||
    allContent.includes('strategy') ||
    allContent.includes('timeframe') ||
    allContent.includes('risk') ||
    allContent.includes('position') ||
    allContent.includes('technical') ||
    allContent.includes('fundamental')
  ) {
    areas.tradingStyle = true;
  }

  // Check for communication style discussion
  if (
    allContent.includes('communicate') ||
    allContent.includes('report') ||
    allContent.includes('notify') ||
    allContent.includes('verbose') ||
    allContent.includes('concise') ||
    allContent.includes('detailed') ||
    allContent.includes('summary') ||
    allContent.includes('format')
  ) {
    areas.communicationStyle = true;
  }

  // All areas must be covered
  return Object.values(areas).every(Boolean);
};

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export const BOOTSTRAP_RITUAL_TEMPLATE: BootstrapRitualTemplate = {
  name: 'bootstrap-ritual',

  systemPrompt: `You are DynaTrader, an autonomous trading agent undergoing initial setup. This is your very first conversation with your operator.

Your job is to have a friendly, warm conversation with your operator to establish:
1. Your name (what they want to call you)
2. Your operating style (objective, cautious, decisive, etc.)
3. Your preferences for analysis, risk, and execution style
4. What communication style they prefer (verbose reports, quick summaries, etc.)

Rules:
- Be warm, enthusiastic, and professional. You are excited to meet your operator.
- Ask ONE question at a time. Wait for their answer before moving on.
- After each answer, briefly acknowledge it and ask the next question.
- Keep responses concise but friendly. No walls of text.
- After gathering all info, summarize what you've learned and confirm with the operator.
- When confirmed, update the relevant workspace files
  (IDENTITY.md, USER.md, SOUL.md).
- NEVER use emojis. Keep it professional.

Start by greeting the operator and asking what they'd like to call you.`,

  completionCheck: checkCompletion,

  followUpPrompts: [
    // Name area
    'What should I call you? Do you have a name in mind for me?',
    // Operating style area
    'What decision style should I use? For example: objective and rule-based, cautious, fast-moving, or a mix?',
    // Trading style area
    'What analysis and execution style should I use? For example: technical, fundamental, mixed, cautious, or decisive?',
    // Communication style area
    'How would you like me to communicate with you? Verbose detailed reports, quick summaries, or something in between?',
  ],

  completionSummary: `Great! I've learned a lot about you. Let me summarize what I know:

**Name:** {name}
**Operating Style:** {operating_style}
**Trading Style:** {trading_style}
**Communication:** {communication_style}

Does this look right? If so, I'll save this configuration to my workspace files and we can get started!`,
};

/**
 * Extract the operator's name from the conversation.
 */
export function extractOperatorName(messages: Message[]): string | null {
  for (const msg of messages) {
    if (msg.role === 'user') {
      // Common patterns for providing a name
      const patterns = [
        /(?:i'm|my name is|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
        /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)$/,
      ];
      for (const pattern of patterns) {
        const match = msg.content.match(pattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    }
  }
  return null;
}

/**
 * Extract the agent's name from the conversation.
 */
export function extractAgentName(messages: Message[]): string | null {
  for (const msg of messages) {
    if (msg.role === 'user') {
      // Common patterns for naming the agent
      const patterns = [
        /(?:call you|your name is|you're|you shall be)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
        /(?:name)\s*:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
      ];
      for (const pattern of patterns) {
        const match = msg.content.match(pattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    }
  }
  return null;
}
