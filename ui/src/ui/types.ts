export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'thinking';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkingPart {
  type: 'thinking';
  text: string;
}

export type MessagePart = TextPart | ThinkingPart;

export type ActivityStatus = 'pending' | 'completed' | 'error';

export interface DiffToolArtifact {
  kind: 'diff';
  path: string;
  oldText: string;
  newText: string;
  isNewFile?: boolean;
  isTruncated?: boolean;
}

export interface WriteToolArtifact {
  kind: 'write';
  path: string;
  contents: string;
  isNewFile?: boolean;
  isTruncated?: boolean;
}

export interface PositionCardArtifact {
  kind: 'position-card';
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  leverage: number;
  liquidationPrice?: number;
}

export interface OrderPreviewArtifact {
  kind: 'order-preview';
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  size: number;
  price?: number;
  totalValue: number;
  fees: number;
  slippage?: number;
}

export interface ChartPreviewArtifact {
  kind: 'chart-preview';
  symbol: string;
  timeframe: string;
  data: string;
}

export interface ShellOutputArtifact {
  kind: 'shell_output';
  command: string;
  exitCode: number;
  shell: string;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

export type ToolArtifact =
  | DiffToolArtifact
  | WriteToolArtifact
  | ShellOutputArtifact
  | PositionCardArtifact
  | OrderPreviewArtifact
  | ChartPreviewArtifact;

/**
 * Message type for UI display in the chat interface
 * Used by ChatMessageItem, ChatMessageList, etc.
 */
export interface Message {
  id?: string;
  role: MessageRole;
  content: string;
  parts?: MessagePart[];
  timestamp: Date;
  status?: ActivityStatus;
  toolName?: string;
  inputPreview?: string;
  resultPreview?: string;
  runId?: string;
  preview?: string;
  toolArtifact?: ToolArtifact;
  commandOutput?: boolean;
  hidden?: boolean;
}
