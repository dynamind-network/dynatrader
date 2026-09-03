/**
 * Shared helper functions for chat message processing.
 *
 * Extracted from App.tsx to reduce its size and enable reuse
 * across hooks and components.
 */
import type { Message, ToolArtifact } from '../types.js';
import type { Message as CoreMessage } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Message construction helpers
// ---------------------------------------------------------------------------

export const createWelcomeMessage = (
  subagents: Array<{ name: string; description?: string }> = []
): Message => {
  const configuredAgents = subagents
    .slice(0, 3)
    .map((agent) => `@${agent.name}`)
    .join(', ');
  const subagentLine = configuredAgents
    ? `workspace agents: ${configuredAgents}`
    : 'No workspace agents configured yet. Add a markdown agent in the workspace agents directory, or use /agents create.';

  return {
    id: 'welcome',
    role: 'system',
    content: `Welcome to Dynamind Terminal v0.1.0 - AI Harness

Quick Start:
- Type /help for available commands
- Use @name to dispatch to configured workspace agents
- Use /agents to list configured agents
- Use /agents create to add a markdown workspace agent
- Use /plan to switch into read-only planning mode
- Use /exit-plan to submit a plan for approval
- Custom tools come from the connected runtime and MCP servers
- Use /tools to inspect the current runtime tool set
- ${subagentLine}

Keyboard Shortcuts:
- Alt+H: Help | Alt+M: Markets | Alt+P: Portfolio
- Alt+T: Trades | Alt+A: Alerts | Alt+Y: Analysis
- Alt+W: Watchlist | Alt+S: Search | Alt+G: Graph
- Alt+O: Models | Alt+R: Chat
- Ctrl+O: View transcript (full history with thinking)
- Ctrl+E: In transcript, toggle between full and recent view

Ready to work. What would you like to explore?`,
    timestamp: new Date(),
  };
};

export const createMessageId = (): string =>
  `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Message serialization / deserialization
// ---------------------------------------------------------------------------

export interface SerializedChatMessage {
  id?: string;
  role: Message['role'];
  content: string;
  timestamp: string;
  status?: Message['status'];
  toolName?: string;
  runId?: string;
  preview?: string;
  toolArtifact?: Message['toolArtifact'];
}

export const serializeChatMessages = (chatMessages: Message[]): SerializedChatMessage[] =>
  chatMessages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    status: message.status,
    toolName: message.toolName,
    runId: message.runId,
    preview: message.preview,
    toolArtifact: message.toolArtifact,
  }));

export const deserializeChatMessages = (
  serializedMessages: SerializedChatMessage[] | undefined
): Message[] =>
  (serializedMessages ?? []).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: new Date(message.timestamp),
    status: message.status,
    toolName: message.toolName,
    runId: message.runId,
    preview: message.preview,
    toolArtifact: message.toolArtifact,
  }));

// ---------------------------------------------------------------------------
// Core message derivation
// ---------------------------------------------------------------------------

export const deriveCoreConversation = (chatMessages: Message[]): CoreMessage[] =>
  chatMessages
    .filter(
      (message): message is Message & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant'
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

// ---------------------------------------------------------------------------
// Tool result summarization
// ---------------------------------------------------------------------------

export const summarizeToolInput = (input: Record<string, unknown>): string => {
  const preview = Object.entries(input)
    .slice(0, 3)
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return `${key}=${value.length > 32 ? `${value.slice(0, 32)}...` : value}`;
      }
      if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return `${key}=${String(value)}`;
      }
      return `${key}=[...]`;
    })
    .join(', ');

  return preview || 'running';
};

export const summarizeToolOutput = (output: string): string => {
  const trimmed = output.trim();
  if (!trimmed) {
    return 'completed';
  }

  const singleLine = trimmed.replace(/\s+/g, ' ');
  if (singleLine.length <= 72) {
    return singleLine;
  }

  const head = singleLine.slice(0, 48);
  const tail = singleLine.slice(-16);
  return `${head} ... ${tail}`;
};

export const getToolArtifact = (
  toolName: string,
  artifacts: Record<string, unknown> | undefined
): ToolArtifact | undefined => {
  if (!artifacts) {
    return undefined;
  }

  // Handle shell output artifact
  if (artifacts.kind === 'shell_output') {
    return {
      kind: 'shell_output',
      command: String(artifacts.command || ''),
      exitCode: Number(artifacts.exitCode) || 0,
      shell: String(artifacts.shell || ''),
      stdout: String(artifacts.stdout || ''),
      stderr: String(artifacts.stderr || ''),
      truncated: artifacts.truncated === true,
    };
  }

  if (artifacts.kind !== 'diff') {
    return undefined;
  }

  if (
    typeof artifacts.path !== 'string' ||
    typeof artifacts.oldText !== 'string' ||
    typeof artifacts.newText !== 'string'
  ) {
    return undefined;
  }

  const diffArtifact: ToolArtifact = {
    kind: 'diff',
    path: artifacts.path,
    oldText: artifacts.oldText,
    newText: artifacts.newText,
    isNewFile: artifacts.isNewFile === true,
    isTruncated: artifacts.isTruncated === true,
  };

  if (toolName === 'write') {
    return {
      kind: 'write',
      path: artifacts.path,
      contents: artifacts.newText,
      isNewFile: artifacts.isNewFile === true,
      isTruncated: artifacts.isTruncated === true,
    };
  }

  return diffArtifact;
};

// ---------------------------------------------------------------------------
// Title generation helpers
// ---------------------------------------------------------------------------

export const deriveSessionTitle = (chatMessages: Message[]): string => {
  const firstUserMessage = chatMessages.find((message) => message.role === 'user');
  if (!firstUserMessage) {
    return 'New chat';
  }

  const singleLine = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return singleLine.slice(0, 60) || 'New chat';
};

export const buildTitleTranscript = (chatMessages: Message[]): string =>
  chatMessages
    .filter(
      (message): message is Message & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant'
    )
    .map((message) => {
      const normalized = message.content.replace(/\s+/g, ' ').trim();
      return `${message.role.toUpperCase()}: ${normalized}`;
    })
    .join('\n');

export const cleanGeneratedTitle = (title: string): string => {
  const cleaned = title
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.slice(0, 60);
};

// ---------------------------------------------------------------------------
// Code block extraction — separates deliverable code from explanation text
// ---------------------------------------------------------------------------

export interface ExtractedCodeBlock {
  language: string;
  code: string;
  suggestedPath: string;
}

export interface SeparatedContent {
  textParts: string;
  codeBlocks: ExtractedCodeBlock[];
}

/**
 * Split assistant response into explanation text and code blocks.
 *
 * This is the core fix for the garbled-output bug: instead of treating
 * the entire LLM response as one undifferentiated string, we extract
 * fenced code blocks (```) and return them separately so they can be
 * rendered as artifacts rather than inline text.
 */
export const extractCodeBlocks = (content: string): SeparatedContent => {
  const codeBlocks: ExtractedCodeBlock[] = [];
  const textParts: string[] = [];

  const lines = content.split('\n');
  let inCodeBlock = false;
  let currentLanguage = '';
  let currentCodeLines: string[] = [];
  let textBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect opening fence: ``` or ```language
    if (!inCodeBlock && line.match(/^```(\w*)/)) {
      // Flush accumulated text
      if (textBuffer.length > 0) {
        textParts.push(textBuffer.join('\n'));
        textBuffer = [];
      }
      inCodeBlock = true;
      currentLanguage = line.match(/^```(\w*)/)?.[1] || '';
      currentCodeLines = [];
      continue;
    }

    // Detect closing fence: ```
    if (inCodeBlock && line.startsWith('```')) {
      inCodeBlock = false;
      const code = currentCodeLines.join('\n');
      if (code.trim().length > 0) {
        const suggestedPath = suggestFilePath(currentLanguage, code, i);
        codeBlocks.push({
          language: currentLanguage,
          code,
          suggestedPath,
        });
      }
      currentLanguage = '';
      currentCodeLines = [];
      continue;
    }

    if (inCodeBlock) {
      currentCodeLines.push(line);
    } else {
      textBuffer.push(line);
    }
  }

  // Flush any remaining text (unclosed code block treated as text)
  if (textBuffer.length > 0) {
    textParts.push(textBuffer.join('\n'));
  }
  // If still in code block at EOF, treat it as text to avoid data loss
  if (inCodeBlock && currentCodeLines.length > 0) {
    textParts.push('```' + currentLanguage, ...currentCodeLines, '```');
  }

  return {
    textParts: textParts.join('\n').trim(),
    codeBlocks,
  };
};

/**
 * Generate a sensible file path from code language and content.
 * Uses heuristics: language extension + first meaningful identifier.
 */
const suggestFilePath = (language: string, code: string, _lineIndex: number): string => {
  const extMap: Record<string, string> = {
    python: '.py',
    py: '.py',
    javascript: '.js',
    js: '.js',
    typescript: '.ts',
    ts: '.ts',
    tsx: '.tsx',
    jsx: '.jsx',
    rust: '.rs',
    go: '.go',
    java: '.java',
    cpp: '.cpp',
    c: '.c',
    h: '.h',
    html: '.html',
    css: '.css',
    scss: '.scss',
    sql: '.sql',
    shell: '.sh',
    bash: '.sh',
    sh: '.sh',
    json: '.json',
    yaml: '.yaml',
    yml: '.yml',
    xml: '.xml',
    markdown: '.md',
    md: '.md',
    ruby: '.rb',
    php: '.php',
    swift: '.swift',
    kotlin: '.kt',
    dockerfile: 'Dockerfile',
  };

  const ext = extMap[language.toLowerCase()] || `.${language}`;

  // Try to extract a class/function name for the file
  const patterns = [
    /class\s+(\w+)/,
    /def\s+(\w+)/,
    /function\s+(\w+)/,
    /const\s+(\w+)\s*=/,
    /let\s+(\w+)\s*=/,
    /var\s+(\w+)\s*=/,
    /struct\s+(\w+)/,
    /interface\s+(\w+)/,
    /package\s+(\w+)/,
  ];

  for (const pattern of patterns) {
    const match = code.match(pattern);
    if (match && match[1]) {
      const name = match[1]
        .toLowerCase()
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase();
      return `${name}${ext}`;
    }
  }

  // Fallback: generic name
  return `generated${ext}`;
};

// ---------------------------------------------------------------------------
// Input placeholder helpers
// ---------------------------------------------------------------------------

interface PlaceholderContext {
  pendingConnectProvider: string | null;
  agentWizard: { step: string } | null;
  pendingQuestion: unknown;
  pendingApprovalCount: number;
  isProcessing: boolean;
  queuedMessageCount: number;
}

export const getInputPlaceholder = (ctx: PlaceholderContext): string => {
  if (ctx.pendingConnectProvider) return `Enter ${ctx.pendingConnectProvider} API key...`;
  if (ctx.agentWizard?.step === 'name') return 'Enter agent name or /cancel...';
  if (ctx.agentWizard?.step === 'description') return 'Enter agent description or /cancel...';
  if (ctx.agentWizard?.step === 'scope') return 'Enter project or global...';
  if (ctx.agentWizard?.step === 'tools') return 'Enter comma-separated tools or all...';
  if (ctx.agentWizard?.step === 'maxTurns') return 'Enter max turns...';
  if (ctx.pendingQuestion) return 'Choose a number or type the label...';
  if (ctx.pendingApprovalCount > 0) return 'Press y to approve or n to deny...';
  if (ctx.queuedMessageCount > 0 && ctx.isProcessing)
    return `Queued ${ctx.queuedMessageCount} message${ctx.queuedMessageCount === 1 ? '' : 's'} ready to run...`;
  if (ctx.queuedMessageCount > 0)
    return `Queued ${ctx.queuedMessageCount} message${ctx.queuedMessageCount === 1 ? '' : 's'}. Press Enter to continue...`;
  if (ctx.isProcessing) return 'Type next message and press Enter to queue...';
  return 'Type a message, /command, or @agent task...';
};
