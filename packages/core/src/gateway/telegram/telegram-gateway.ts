/**
 * TelegramGateway
 *
 * Real Telegram bot gateway that connects to the Telegram Bot API
 * using raw fetch() polling (long polling).
 *
 * Responsibilities:
 * - Polls getUpdates with long polling (timeout=30)
 * - Sends messages via sendMessage API
 * - Filters out bot's own messages
 * - Supports optional chat ID whitelist
 * - Graceful shutdown via AbortController
 */

import http from "node:http";
import type { CallbackRouter } from "./callback-router";
import type { CommandRouter } from "./command-router";
import type { GatewayStatus } from "../discord-gateway";
import { Logger } from "../../audit/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A message received from the real Telegram Bot API. */
export interface TelegramMessage {
  chatId: number;
  text: string;
  userId: number;
  username?: string;
  messageId: number;
  voice?: { fileId: string; duration?: number; mimeType?: string };
}

/** A callback query from an inline keyboard button press. */
export interface TelegramCallbackQuery {
  chatId: number;
  text: string;
  userId: number;
  username?: string;
  messageId: number;
  callbackQueryId: string;
}

export interface TelegramMessageReference {
  chatId: number;
  messageId: number;
}

export type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export interface ReplyKeyboardOptions {
  keyboard: string[][];
  resizeKeyboard?: boolean;
  oneTimeKeyboard?: boolean;
  selective?: boolean;
  inputFieldPlaceholder?: string;
}

export interface BotCommand {
  command: string;
  description: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_BACKOFF_MS = [1000, 2000, 4000, 8000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFormDataFieldName(filename: string): "photo" | "document" {
  return /\.(png|jpg|jpeg|gif|webp|bmp|tiff)$/i.test(filename) ? "photo" : "document";
}

// ---------------------------------------------------------------------------
// TelegramGateway
// ---------------------------------------------------------------------------

export class TelegramGateway {
  readonly name = "telegram";
  private token = "";
  private sendOnly = false;
  private connected = false;
  private startedAt: Date | null = null;
  private polling = false;
  private offset = 0;
  private totalMessages = 0;
  private readonly messageCallbacks = new Set<(msg: TelegramMessage) => void>();
  private readonly callbackCallbacks = new Set<(cb: TelegramCallbackQuery) => void>();
  private allowedChatIds: Set<number> | null = null;
  private abortController: AbortController | null = null;
  private readonly logger = new Logger("TelegramGateway");

  private commandRouter: CommandRouter | null = null;
  private callbackRouter: CallbackRouter | null = null;

  private webhookServer: http.Server | null = null;
  private webhookActive = false;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize the gateway with a bot token and optional chat ID whitelist.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    this.token = config.token as string;
    if (!this.token) {
      throw new Error("TelegramGateway requires a 'token' in config");
    }
    if (Array.isArray(config.allowedChatIds)) {
      const ids = config.allowedChatIds as number[];
      this.allowedChatIds = ids.length > 0 ? new Set(ids) : null;
    }
    this.sendOnly = config.sendOnly === true;
    if (!this.allowedChatIds?.size && !this.sendOnly) {
      throw new Error("TelegramGateway requires allowedChatIds for inbound access (deny-by-default)");
    }
  }

  /**
   * Start polling the Telegram Bot API for updates.
   */
  async start(): Promise<void> {
    if (!this.token) {
      throw new Error("TelegramGateway not initialized: call initialize() first");
    }
    if (this.sendOnly || !this.allowedChatIds?.size) {
      throw new Error("Telegram inbound gateway requires an allowlist. Run `dynatrader gateway telegram setup` first.");
    }
    this.connected = true;
    this.startedAt = new Date();
    this.polling = true;
    this.logger.info("TelegramGateway starting", {
      hasAllowedChatIds: this.allowedChatIds !== null,
    });
    void this.pollLoop();
  }

  /**
   * Stop polling and disconnect.
   */
  async stop(): Promise<void> {
    await this.stopWebhook();
    this.polling = false;
    this.connected = false;
    this.abortController?.abort();
    this.logger.info("TelegramGateway stopped");
  }

  /**
   * Register a CommandRouter to handle /commands.
   */
  setCommandRouter(router: CommandRouter): void {
    this.commandRouter = router;
  }

  /**
   * Register a CallbackRouter to handle callback queries after ApprovalManager.
   */
  setCallbackRouter(router: CallbackRouter): void {
    this.callbackRouter = router;
  }

  // -----------------------------------------------------------------------
  // Webhook mode
  // -----------------------------------------------------------------------

  /**
   * Start webhook mode: register a webhook URL with Telegram and start an HTTP server
   * to receive incoming updates.
   */
  async startWebhook(webhookUrl: string, port = 8443): Promise<void> {
    if (!this.token) {
      throw new Error("TelegramGateway not initialized: call initialize() first");
    }
    if (!this.allowedChatIds?.size) {
      throw new Error("Telegram inbound gateway requires an allowlist. Run `dynatrader gateway telegram setup` first.");
    }

    const setUrl = `https://api.telegram.org/bot${this.token}/setWebhook`;
    const response = await fetch(setUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message", "callback_query"] }),
    });
    const data = (await response.json()) as TelegramApiResponse<boolean>;
    if (!data.ok) {
      throw new Error(`Telegram setWebhook failed: ${data.description}`);
    }

    this.webhookServer = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      let body = "";
      const MAX_BODY_SIZE = 1024 * 1024; // 1MB
      let bodySize = 0;
      req.on("data", (chunk) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_SIZE) {
          req.destroy();
          return;
        }
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const update = JSON.parse(body) as {
            update_id: number;
            message?: {
              message_id: number;
              chat: { id: number };
              from: { id: number; is_bot: boolean; username?: string };
              text?: string;
              voice?: { file_id: string; duration?: number; mime_type?: string };
            };
            callback_query?: {
              id: string;
              message?: {
                message_id: number;
                chat: { id: number };
              };
              from: { id: number; is_bot: boolean; username?: string };
              data?: string;
            };
          };
          this.processUpdate(update);
        } catch {
          this.logger.error("Failed to parse webhook update");
        }
        res.writeHead(200);
        res.end("ok");
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.webhookServer!.listen(port, () => {
        this.webhookActive = true;
        this.connected = true;
        this.startedAt = new Date();
        this.logger.info("TelegramGateway webhook started", { port, webhookUrl });
        resolve();
      });
      this.webhookServer!.on("error", reject);
    });
  }

  /**
   * Stop webhook mode: deregister the webhook and close the HTTP server.
   */
  async stopWebhook(): Promise<void> {
    if (!this.webhookActive) return;

    const delUrl = `https://api.telegram.org/bot${this.token}/deleteWebhook`;
    try {
      await fetch(delUrl, { method: "GET" });
    } catch {
      // best effort
    }

    if (this.webhookServer) {
      await new Promise<void>((resolve) => {
        this.webhookServer!.close(() => resolve());
      });
      this.webhookServer = null;
    }

    this.webhookActive = false;
    this.connected = false;
    this.logger.info("TelegramGateway webhook stopped");
  }

  private processUpdate(update: {
    update_id: number;
    message?: {
      message_id: number;
      chat: { id: number };
      from: { id: number; is_bot: boolean; username?: string };
      text?: string;
      voice?: { file_id: string; duration?: number; mime_type?: string };
    };
    callback_query?: {
      id: string;
      message?: {
        message_id: number;
        chat: { id: number };
      };
      from: { id: number; is_bot: boolean; username?: string };
      data?: string;
    };
  }): void {
    if (update.message && !update.message.from?.is_bot) {
      if (this.allowedChatIds && !this.allowedChatIds.has(update.message.chat.id)) {
        return;
      }

      this.totalMessages++;

      const msg: TelegramMessage = {
        chatId: update.message.chat.id,
        text: update.message.text ?? "",
        userId: update.message.from.id,
        username: update.message.from.username,
        messageId: update.message.message_id,
        ...(update.message.voice
          ? {
              voice: {
                fileId: update.message.voice.file_id,
                duration: update.message.voice.duration,
                mimeType: update.message.voice.mime_type,
              },
            }
          : {}),
      };

      for (const cb of this.messageCallbacks) {
        try {
          cb(msg);
        } catch (err) {
          this.logger.error("Message callback error", { error: err });
        }
      }
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      if (!cq.from?.is_bot) {
        const cqChatId = cq.message?.chat?.id ?? 0;
        if (this.allowedChatIds && cqChatId && !this.allowedChatIds.has(cqChatId)) {
          return;
        }

        const callbackQuery: TelegramCallbackQuery = {
          chatId: cqChatId,
          text: cq.data ?? "",
          userId: cq.from.id,
          username: cq.from.username,
          messageId: cq.message?.message_id ?? 0,
          callbackQueryId: cq.id,
        };

        for (const cb of this.callbackCallbacks) {
          try {
            cb(callbackQuery);
          } catch (err) {
            this.logger.error("Callback query error", { error: err });
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  /**
   * Send a text message to a Telegram chat via the Bot API.
   * @param chatId - The Telegram chat ID (as a string, since GatewayPlugin.send uses string channel)
   * @param content - The message text to send
   */
  async send(chatId: string, content: string): Promise<TelegramMessageReference> {
    return this.sendMessage(chatId, content);
  }

  async sendMessage(
    chatId: string,
    content: string,
    options?: {
      parseMode?: "MarkdownV2" | "Markdown" | "HTML";
      replyMarkup?: unknown;
      disableWebPagePreview?: boolean;
    },
  ): Promise<TelegramMessageReference> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: content.slice(0, TELEGRAM_MESSAGE_LIMIT),
    };
    if (options?.parseMode) payload.parse_mode = options.parseMode;
    if (options?.replyMarkup) payload.reply_markup = options.replyMarkup;
    if (options?.disableWebPagePreview) payload.disable_web_page_preview = true;

    const result = await this.requestWithBackoff<{ message_id: number; chat: { id: number } }>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      "sendMessage",
    );
    return { chatId: result.chat.id, messageId: result.message_id };
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    content: string,
    options?: {
      parseMode?: "MarkdownV2" | "Markdown" | "HTML";
      replyMarkup?: unknown;
      disableWebPagePreview?: boolean;
    },
  ): Promise<TelegramMessageReference> {
    const url = `https://api.telegram.org/bot${this.token}/editMessageText`;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: content.slice(0, TELEGRAM_MESSAGE_LIMIT),
    };
    if (options?.parseMode) payload.parse_mode = options.parseMode;
    if (options?.replyMarkup) payload.reply_markup = options.replyMarkup;
    if (options?.disableWebPagePreview) payload.disable_web_page_preview = true;

    const result = await this.requestWithBackoff<{ message_id: number; chat: { id: number } }>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      "editMessageText",
    );
    return { chatId: result.chat.id, messageId: result.message_id };
  }

  async sendMarkdown(chatId: string, content: string): Promise<TelegramMessageReference> {
    try {
      return await this.sendMessage(chatId, content, {
        parseMode: "MarkdownV2",
        disableWebPagePreview: true,
      });
    } catch (error) {
      this.logger.warn("Markdown send failed, falling back to plain text", { error });
      return this.sendMessage(chatId, content);
    }
  }

  async editMarkdown(chatId: string, messageId: number, content: string): Promise<TelegramMessageReference> {
    try {
      return await this.editMessageText(chatId, messageId, content, {
        parseMode: "MarkdownV2",
        disableWebPagePreview: true,
      });
    } catch (error) {
      this.logger.warn("Markdown edit failed, falling back to plain text", { error });
      return this.editMessageText(chatId, messageId, content);
    }
  }

  /** Download a Telegram voice/file payload for transcription or processing. */
  async downloadFile(fileId: string): Promise<Uint8Array> {
    if (!fileId) throw new Error("Telegram fileId is required");
    const fileData = await this.requestWithBackoff<{ file_path?: string }>(
      `https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { method: "GET" },
      "getFile",
    );
    if (!fileData.file_path) throw new Error("Telegram getFile failed");
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${fileData.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Send synthesized audio as a Telegram voice message. */
  async sendVoice(chatId: string, audio: Uint8Array, filename = "response.mp3"): Promise<TelegramMessageReference> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("voice", new Blob([audio]), filename);
    const result = await this.requestWithBackoff<{ message_id: number; chat: { id: number } }>(
      `https://api.telegram.org/bot${this.token}/sendVoice`,
      { method: "POST", body: form },
      "sendVoice",
    );
    return { chatId: result.chat.id, messageId: result.message_id };
  }

  async sendPhoto(
    chatId: string,
    photo: Uint8Array,
    filename = "image.png",
    caption?: string,
  ): Promise<TelegramMessageReference> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", new Blob([photo]), filename);
    if (caption) form.append("caption", caption.slice(0, TELEGRAM_MESSAGE_LIMIT));
    const result = await this.requestWithBackoff<{ message_id: number; chat: { id: number } }>(
      `https://api.telegram.org/bot${this.token}/sendPhoto`,
      { method: "POST", body: form },
      "sendPhoto",
    );
    return { chatId: result.chat.id, messageId: result.message_id };
  }

  async sendDocument(
    chatId: string,
    document: Uint8Array,
    filename = "document.bin",
    caption?: string,
  ): Promise<TelegramMessageReference> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("document", new Blob([document]), filename);
    if (caption) form.append("caption", caption.slice(0, TELEGRAM_MESSAGE_LIMIT));
    const result = await this.requestWithBackoff<{ message_id: number; chat: { id: number } }>(
      `https://api.telegram.org/bot${this.token}/sendDocument`,
      { method: "POST", body: form },
      "sendDocument",
    );
    return { chatId: result.chat.id, messageId: result.message_id };
  }

  async sendMediaFromBuffer(
    chatId: string,
    content: Uint8Array,
    filename: string,
    caption?: string,
  ): Promise<TelegramMessageReference> {
    if (buildFormDataFieldName(filename) === "photo") {
      return this.sendPhoto(chatId, content, filename, caption);
    }
    return this.sendDocument(chatId, content, filename, caption);
  }

  // -----------------------------------------------------------------------
  // Chat actions (typing indicators)
  // -----------------------------------------------------------------------

  /**
   * Send a chat action to the Telegram API (e.g. "typing" indicator).
   */
  async sendChatAction(chatId: number, action: ChatAction): Promise<boolean> {
    const url = `https://api.telegram.org/bot${this.token}/sendChatAction`;
    const payload = { chat_id: chatId, action };
    try {
      await this.requestWithBackoff<boolean>(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "sendChatAction",
      );
      return true;
    } catch (error) {
      this.logger.error("sendChatAction failed", { chatId, action, error });
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Inline keyboards
  // -----------------------------------------------------------------------

  /**
   * Send a text message with inline keyboard buttons.
   * @param chatId - The Telegram chat ID (as a string)
   * @param content - The message text
   * @param keyboard - 2D array of inline keyboard buttons
   */
  async sendWithInlineKeyboard(
    chatId: string,
    content: string,
    keyboard: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<TelegramMessageReference> {
    return this.sendMessage(chatId, content, { replyMarkup: { inline_keyboard: keyboard } });
  }

  /**
   * Answer a callback query to stop the loading indicator on the button.
   * Telegram requires this after processing an inline keyboard callback.
   * @param callbackQueryId - The callback query ID from the update
   * @param text - Optional text to show as a toast notification
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const params = new URLSearchParams({ callback_query_id: callbackQueryId });
    if (text) params.set("text", text);
    const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery?${params}`;
    await this.requestWithBackoff<void>(url, { method: "GET" }, "answerCallbackQuery").catch((error) => {
      this.logger.error("Failed to answer callback query", {
        callbackQueryId,
        error,
      });
    });
  }

  // -----------------------------------------------------------------------
  // Reply keyboards
  // -----------------------------------------------------------------------

  /**
   * Send a text message with a reply keyboard.
   */
  async sendWithReplyKeyboard(
    chatId: string,
    content: string,
    keyboard: ReplyKeyboardOptions,
  ): Promise<TelegramMessageReference> {
    const replyMarkup: Record<string, unknown> = {
      keyboard: keyboard.keyboard.map((row) => row.map((btn) => ({ text: btn }))),
      resize_keyboard: keyboard.resizeKeyboard ?? true,
      one_time_keyboard: keyboard.oneTimeKeyboard ?? false,
    };
    if (keyboard.selective !== undefined) replyMarkup.selective = keyboard.selective;
    if (keyboard.inputFieldPlaceholder) replyMarkup.input_field_placeholder = keyboard.inputFieldPlaceholder;

    return this.sendMessage(chatId, content, { replyMarkup });
  }

  /**
   * Remove the reply keyboard and send a message.
   */
  async removeReplyKeyboard(chatId: string, content: string): Promise<TelegramMessageReference> {
    const replyMarkup = { remove_keyboard: true };
    return this.sendMessage(chatId, content, { replyMarkup });
  }

  // -----------------------------------------------------------------------
  // Bot commands
  // -----------------------------------------------------------------------

  /**
   * Set the bot's command list shown in the Telegram UI.
   */
  async setMyCommands(commands: BotCommand[]): Promise<boolean> {
    const url = `https://api.telegram.org/bot${this.token}/setMyCommands`;
    const payload = { commands };
    try {
      await this.requestWithBackoff<boolean>(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "setMyCommands",
      );
      return true;
    } catch (error) {
      this.logger.error("setMyCommands failed", { error });
      return false;
    }
  }

  async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.requestWithBackoff<{ id: number; username?: string; first_name?: string }>(`https://api.telegram.org/bot${this.token}/getMe`, { method: "GET" }, "getMe");
  }

  async getChat(chatId: string | number): Promise<{ id: number; type: string; title?: string; username?: string }> {
    return this.requestWithBackoff<{ id: number; type: string; title?: string; username?: string }>(
      `https://api.telegram.org/bot${this.token}/getChat?chat_id=${encodeURIComponent(String(chatId))}`,
      { method: "GET" },
      "getChat",
    );
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  /**
   * Return the current connection status.
   */
  getStatus(): GatewayStatus {
    return {
      connected: this.connected,
      startedAt: this.startedAt ?? undefined,
      guildCount: 1,
      channelCount: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Event hooks
  // -----------------------------------------------------------------------

  /**
   * Register a callback that fires on every incoming message.
   * Bot messages and non-whitelisted chats are automatically filtered.
   */
  onMessage(callback: (msg: TelegramMessage) => void): void {
    this.messageCallbacks.add(callback);
  }

  /**
   * Remove a previously registered message callback.
   */
  offMessage(callback: (msg: TelegramMessage) => void): void {
    this.messageCallbacks.delete(callback);
  }

  /**
   * Register a callback that fires on every incoming callback query (inline button press).
   */
  onCallbackQuery(callback: (cb: TelegramCallbackQuery) => void): void {
    this.callbackCallbacks.add(callback);
  }

  /**
   * Remove a previously registered callback query handler.
   */
  offCallbackQuery(callback: (cb: TelegramCallbackQuery) => void): void {
    this.callbackCallbacks.delete(callback);
  }

  // -----------------------------------------------------------------------
  // Polling loop
  // -----------------------------------------------------------------------

  /**
   * Long-poll getUpdates in a loop until stop() is called.
   * Each request blocks for up to 30 seconds (Telegram long polling).
   */
  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=30`;
        const controller = new AbortController();
        this.abortController = controller;

        const response = await fetch(url, { signal: controller.signal });
        const data = (await response.json()) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              message_id: number;
              chat: { id: number };
              from: { id: number; is_bot: boolean; username?: string };
              text?: string;
              voice?: { file_id: string; duration?: number; mime_type?: string };
            };
            callback_query?: {
              id: string;
              message?: {
                message_id: number;
                chat: { id: number };
              };
              from: { id: number; is_bot: boolean; username?: string };
              data?: string;
            };
          }>;
        };

        if (data.ok && data.result) {
          for (const update of data.result) {
            this.offset = update.update_id + 1;

            if (update.message && !update.message.from?.is_bot) {
              if (this.allowedChatIds && !this.allowedChatIds.has(update.message.chat.id)) {
                continue;
              }

              this.totalMessages++;

              const msg: TelegramMessage = {
                chatId: update.message.chat.id,
                text: update.message.text ?? "",
                userId: update.message.from.id,
                username: update.message.from.username,
                messageId: update.message.message_id,
                ...(update.message.voice
                  ? {
                      voice: {
                        fileId: update.message.voice.file_id,
                        duration: update.message.voice.duration,
                        mimeType: update.message.voice.mime_type,
                      },
                    }
                  : {}),
              };

              for (const cb of this.messageCallbacks) {
                try {
                  cb(msg);
                } catch (err) {
                  this.logger.error("Message callback error", { error: err });
                }
              }
            }

            if (update.callback_query) {
              const cq = update.callback_query;
              if (!cq.from?.is_bot) {
                const cqChatId = cq.message?.chat?.id ?? 0;
                if (this.allowedChatIds && cqChatId && !this.allowedChatIds.has(cqChatId)) {
                  continue;
                }

                const callbackQuery: TelegramCallbackQuery = {
                  chatId: cqChatId,
                  text: cq.data ?? "",
                  userId: cq.from.id,
                  username: cq.from.username,
                  messageId: cq.message?.message_id ?? 0,
                  callbackQueryId: cq.id,
                };

                for (const cb of this.callbackCallbacks) {
                  try {
                    cb(callbackQuery);
                  } catch (err) {
                    this.logger.error("Callback query error", { error: err });
                  }
                }
              }
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          break;
        }
        this.logger.error("Polling error, retrying with backoff", { error: err });
        await sleep(5000);
      }
    }
  }

  private async requestWithBackoff<T>(
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= TELEGRAM_BACKOFF_MS.length; attempt++) {
      try {
        const response = await fetch(url, init);
        const text = await response.text();
        let parsed: TelegramApiResponse<T> | null = null;
        if (text) {
          try {
            parsed = JSON.parse(text) as TelegramApiResponse<T>;
          } catch {
            parsed = null;
          }
        }

        if (response.ok && parsed?.ok && parsed.result !== undefined) {
          return parsed.result;
        }

        const retryAfter = parsed?.parameters?.retry_after;
        if ((response.status === 429 || retryAfter) && attempt < TELEGRAM_BACKOFF_MS.length) {
          const waitMs = retryAfter ? retryAfter * 1000 : TELEGRAM_BACKOFF_MS[attempt]!;
          this.logger.warn(`Telegram ${operation} rate limited, retrying`, {
            status: response.status,
            retryAfter,
            attempt,
          });
          await sleep(waitMs);
          continue;
        }

        if (attempt < TELEGRAM_BACKOFF_MS.length) {
          const waitMs = TELEGRAM_BACKOFF_MS[attempt]!;
          this.logger.warn(`Telegram ${operation} failed, retrying`, {
            status: response.status,
            attempt,
            waitMs,
          });
          await sleep(waitMs);
          continue;
        }

        throw new Error(`Telegram ${operation} failed: ${response.status} ${parsed?.description ?? text}`);
      } catch (error) {
        lastError = error;
        if (attempt >= TELEGRAM_BACKOFF_MS.length) {
          break;
        }
        await sleep(TELEGRAM_BACKOFF_MS[attempt]!);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Telegram ${operation} failed`);
  }
}
