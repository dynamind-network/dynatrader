export interface TelegramChatOptions {
  sessionId: string;
  templateName: string;
  allowTools: true;
}

export function buildTelegramChatOptions(sessionId: string): TelegramChatOptions {
  return {
    sessionId,
    templateName: "dynatrader-conversation",
    allowTools: true,
  };
}
