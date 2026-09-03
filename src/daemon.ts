#!/usr/bin/env node

/**
 * DynaTrader Daemon
 *
 * Headless runtime entry point for production deployment.
 * Starts the DynaTraderRuntime and runs indefinitely, processing
 * messages via Telegram/Discord gateways and cron jobs.
 *
 * Usage:
 *   DYNA_WORKSPACE=./workspace DYNA_MODE=paper tsx src/daemon.ts
 *
 * This daemon:
 * - Writes its PID to {workspace}/.dynad.pid for process monitoring
 * - Logs to {workspace}/logs/daemon.log
 * - Responds to SIGINT/SIGTERM for graceful shutdown
 * - Runs until signaled
 *
 * The agent is a conversational trading agent:
 * - Always on, always aware of market context
 * - Responds naturally to Telegram/Discord messages
 * - Uses trading tools when relevant
 * - Cron jobs run market analysis and deliver to Telegram
 */

import { DynaTraderRuntime } from './orchestration/workspace/index';
import type { RuntimeConfig } from './orchestration/workspace/types';
import { ensureWorkspace } from './workspace-init';
import { basename, extname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { appendFile } from 'node:fs/promises';
import { HealthServer } from './health-server';
import { TelegramGateway } from './gateway/telegram/telegram-gateway';
import type { TelegramMessage } from './gateway/telegram/telegram-gateway';
import { ApprovalManager } from './gateway/telegram/approval-manager';
import { HaltTradingTool } from './agent/tools/risk-tools';
import { CommandRouter } from './gateway/telegram/command-router';
import { CallbackRouter } from './gateway/telegram/callback-router';
import { DiscordGateway } from './gateway/discord-gateway';

import { VoiceTranscriptionTool } from './runtime/tools/tools/voice-transcription-tool';
import { TtsTool } from './runtime/tools/tools/tts-tool';
import { resolveGatewayRuntimeConfig } from './gateway/runtime-gateway';
import { requireVisibleResponse } from './runtime/visible-response';
import { buildTelegramChatOptions } from './runtime/telegram-turn';

const DEFAULT_MODE: RuntimeConfig['mode'] = 'paper';

type WorkspaceSource = 'env' | 'repo' | 'home';
type ModelReadiness =
  | {
      status: 'unconfigured';
    }
  | {
      status: 'ready';
      provider: string;
      configuredModel: string;
      resolvedModel: string;
    }
  | {
      status: 'degraded';
      provider: string;
      configuredModel: string;
      error: string;
    };

/** Simple file logger for the daemon */
function logToFile(logPath: string, message: string): void {
  appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`).catch(() => {});
}

async function resolveTradingSymbol(runtime: DynaTraderRuntime, text: string): Promise<string | undefined> {
  const textMatch = text.match(/\b([A-Z0-9]+\/[A-Z0-9]+)\b/);
  if (textMatch?.[1]) {
    return textMatch[1];
  }

  // Never infer an instrument from an exchange catalogue or environment.
  // Each daemon task must provide its symbol explicitly or via workspace policy.
  return undefined;
}

function extractMediaPaths(content: string): { text: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const text = content
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*MEDIA:\s*(.+?)\s*$/i);
      if (!match?.[1]) {
        return true;
      }
      mediaPaths.push(match[1].trim());
      return false;
    })
    .join('\n')
    .trim();
  return { text, mediaPaths };
}

function isImagePath(filePath: string): boolean {
  const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']);
  return imageExtensions.has(extname(filePath).toLowerCase());
}

async function main(): Promise<void> {
  const workspacePath = await ensureWorkspace();
  const mode = (process.env['DYNA_MODE'] as RuntimeConfig['mode']) ?? DEFAULT_MODE;
  const showThinking = process.env['DYNA_SHOW_THINKING']?.toLowerCase() !== 'false';
  const workspaceSource: WorkspaceSource = process.env['DYNA_WORKSPACE'] ? 'env' : 'home';
  let modelReadiness: ModelReadiness = { status: 'unconfigured' };

  // Ensure logs directory exists
  const logsDir = join(workspacePath, 'logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  const logPath = join(logsDir, 'daemon.log');

  // Write PID file for process monitoring (DaemonController reads this)
  const pidFilePath = join(workspacePath, '.dynad.pid');

  // Clean up stale PID file from previous crash
  try {
    const oldPid = readFileSync(pidFilePath, 'utf-8').trim();
    try {
      process.kill(parseInt(oldPid, 10), 0);
      console.error(`Daemon already running with PID ${oldPid}`);
      process.exit(1);
    } catch {
      unlinkSync(pidFilePath); // Process not alive — remove stale PID
    }
  } catch { /* No PID file, proceed */ }

  try {
    writeFileSync(pidFilePath, String(process.pid), 'utf-8');
  } catch (err) {
    console.error(`Failed to write PID file at ${pidFilePath}:`, err);
    process.exit(1);
  }

  logToFile(
    logPath,
    `Daemon starting (PID: ${process.pid}, mode: ${mode}, workspace: ${workspacePath}, source: ${workspaceSource})`,
  );

  const config: RuntimeConfig = {
    workspacePath,
    mode,
    strictMode: process.env['DYNA_STRICT'] === 'true',
    requireRiskProfile: false,
    requireTradingPolicy: false,
    requireAuthConfig: false,
    liveTradingEnabled: process.env['DYNA_LIVE'] === 'true',
    enableShadowMode: process.env['DYNA_SHADOW'] === 'true',
    enableMicroLiveMode: process.env['DYNA_MICRO_LIVE'] === 'true',
  };

  const runtime = new DynaTraderRuntime(workspacePath, config);
  await runtime.start();

  // Autonomy notice: live/micro-live means the agent places real orders
  // without human confirmation — make that unmistakable at startup.
  if (config.liveTradingEnabled || config.enableMicroLiveMode) {
    const banner = [
      '',
      '════════════════════════════════════════════════════════',
      '  ⚠️  LIVE TRADING — AUTONOMOUS MODE ENABLED',
      '  The agent will place REAL orders with NO human confirmation.',
      '  Safety model: capital caps (micro-live), risk tools, kill switches',
      '  (`dyna halt` / Telegram /halt halts everything immediately).',
      `  Mode: ${config.liveTradingEnabled ? 'LIVE' : 'MICRO-LIVE'} | Kill switch file: ${join(workspacePath, 'state', 'halt.json')}`,
      '════════════════════════════════════════════════════════',
      '',
    ].join('\n');
    console.error(banner);
    logToFile(logPath, 'LIVE TRADING — AUTONOMOUS MODE ENABLED (no human approval gate)');
  }

  const loadedWorkspace = await runtime.loadWorkspace();
  const gatewayConfig = resolveGatewayRuntimeConfig(loadedWorkspace.config, process.env);
  const configuredProvider = loadedWorkspace.config?.models?.provider?.trim();
  const configuredModel = loadedWorkspace.config?.models?.model?.trim();

  if (configuredProvider && configuredModel) {
    const modelRouter = runtime.getModelRouter();
    const activeModelId = `${configuredProvider}/${configuredModel}`;
    try {
      modelRouter.switchModel(activeModelId);
      const provider = modelRouter.getProvider(configuredProvider);
      if (!provider) {
        throw new Error(`Configured provider not registered: ${configuredProvider}`);
      }
      const probe = await provider.call(
        {
          messages: [
            { role: 'system', content: 'You are a runtime readiness probe. Reply with exactly OK.' },
            { role: 'user', content: 'ping' },
          ],
          maxTokens: 64,
          temperature: 0,
          model: configuredModel,
        },
      );
      const probeText = requireVisibleResponse(
        probe.content,
        probe.reasoningContent,
        `Model readiness check for ${activeModelId}`,
        showThinking,
      );
      modelReadiness = {
        status: 'ready',
        provider: configuredProvider,
        configuredModel,
        resolvedModel: probe.model,
      };
      logToFile(logPath, `Model readiness check passed for ${activeModelId}: ${probe.model} (${probeText})`);
      console.log(`Model readiness: ${activeModelId} -> ${probe.model} (${probeText})`);
    } catch (error) {
      const message = (error as Error).message;
      modelReadiness = {
        status: 'degraded',
        provider: configuredProvider,
        configuredModel,
        error: message,
      };
      logToFile(logPath, `Model readiness check failed for ${activeModelId}: ${message}`);
      console.warn(`Model readiness degraded for ${activeModelId}: ${message}`);
    }
  } else {
    logToFile(logPath, 'Model readiness check skipped: workspace config.models.provider/model not set');
    console.warn('Model readiness skipped: configure models.provider and models.model in workspace config');
  }

  const status = runtime.getStatus();
  const componentCount = Object.entries(status.components).filter(([_, v]) => v).length;
  const totalComponents = Object.keys(status.components).length;

  logToFile(logPath, `Daemon started: ${componentCount}/${totalComponents} components, mode=${mode}`);
  console.log(`DynaTrader daemon started (PID: ${process.pid}, mode: ${mode}, workspace: ${workspacePath})`);
  console.log(`Workspace source: ${workspaceSource}`);
  console.log(`Components: ${componentCount}/${totalComponents} initialized`);

  // CronEngine is started as part of the runtime.
  const cronEngine = runtime.getCronEngine();
  const cronStatus = cronEngine.getStatus();
  logToFile(
    logPath,
    `CronEngine: ${cronStatus.jobCount} jobs, ${cronStatus.enabledJobs} enabled, running=${cronStatus.running}`
  );
  console.log(
    `CronEngine: ${cronStatus.jobCount} jobs, ${cronStatus.enabledJobs} enabled`
  );

  // Auto-enable heartbeat if DYNA_HEARTBEAT=true
  const heartbeatEnabled = process.env['DYNA_HEARTBEAT'] === 'true';
  const heartbeatInterval = parseInt(process.env['DYNA_HEARTBEAT_INTERVAL'] ?? '30', 10);
  const allJobs = await cronEngine.listJobs();
  const existingHeartbeat = allJobs.find((j) => j.tags?.includes('heartbeat'));
  if (existingHeartbeat) {
    if (heartbeatEnabled && !existingHeartbeat.enabled) {
      await cronEngine.resumeJob(existingHeartbeat.id);
      logToFile(logPath, `Heartbeat auto-enabled (every ${heartbeatInterval}m)`);
      console.log(`Heartbeat: auto-enabled (every ${heartbeatInterval}m)`);
    }
  } else if (heartbeatEnabled) {
    await cronEngine.createHeartbeatJob(heartbeatInterval, true);
    logToFile(logPath, `Heartbeat: created and enabled (every ${heartbeatInterval}m)`);
    console.log(`Heartbeat: created and enabled (every ${heartbeatInterval}m)`);
  }

  // Start health server
  const healthServer = new HealthServer({
    port: parseInt(process.env['HEALTH_PORT'] ?? '9090', 10),
    getHealthInfo: () => {
      const modelOk = modelReadiness.status === 'ready';
      const status = !modelOk ? 'degraded' : 'ok';
      return {
        status,
        version: '2.3.0',
        uptime: process.uptime(),
        mode,
        components: componentCount,
        startedAt: runtime.getStatus().startedAt,
        workspace: workspacePath,
        workspaceSource,
        model: modelReadiness,
      };
    },
  });
  await healthServer.start();
  logToFile(logPath, `Health server started on port ${process.env['HEALTH_PORT'] ?? '9090'}`);

  // Get session and channel managers
  const sessionManager = runtime.getSessionManager();
  const channelManager = runtime.getChannelManager();
  const agent = runtime.getAgent();

  // --- Start Telegram Gateway (if token configured) ---
  let tgGateway: TelegramGateway | null = null;
  let approvalManager: ApprovalManager | null = null;
  const voiceTranscription = process.env['OPENAI_API_KEY'] ? new VoiceTranscriptionTool() : null;
  const tts = process.env['OPENAI_API_KEY'] && process.env['DYNA_TTS_RESPONSES'] === 'true' ? new TtsTool() : null;
  let activeTelegramApprovalChatId: number | null = null;
  let pendingTelegramTurns = 0;
  let pendingDiscordTurns = 0;

  if (gatewayConfig.telegram.enabled) {
    tgGateway = new TelegramGateway();
    if (!gatewayConfig.telegram.token) {
      throw new Error('Telegram gateway is enabled but TELEGRAM_BOT_TOKEN is missing');
    }
    await tgGateway.initialize({
      token: gatewayConfig.telegram.token,
      allowedChatIds: gatewayConfig.telegram.allowedChatIds,
    });
    await tgGateway.start();
    logToFile(logPath, 'Telegram gateway started');
    console.log('Telegram gateway: connected');

    // Initialize ApprovalManager for gating dangerous operations
    approvalManager = new ApprovalManager(tgGateway, gatewayConfig.telegram.allowedChatIds);

    // Initialize CommandRouter and CallbackRouter for structured command handling
    const commandRouter = new CommandRouter();
    const haltTool = new HaltTradingTool({ workspacePath });
    const callbackRouter = new CallbackRouter();

    // Register standard /commands
    const defaultChatId = gatewayConfig.telegram.defaultChatId ?? process.env['TELEGRAM_DEFAULT_CHAT_ID'];
    commandRouter.register({
      command: 'start',
      description: 'Start a conversation with the trading agent',
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /start from user ${ctx.username || ctx.userId}`);
        return `Welcome to DynaTrader! I'm your conversational trading assistant.\n\nSend me a message or use /help to see available commands.`;
      },
    });
    commandRouter.register({
      command: 'help',
      description: 'Show this help message',
      aliases: ['h', '?'],
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /help from user ${ctx.username || ctx.userId}`);
        const helpText = commandRouter.getHelpText();
        return `${helpText}\n\nOr just send any message to chat with the agent!`;
      },
    });
    commandRouter.register({
      command: 'status',
      description: 'Show the current runtime status and session info',
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /status from user ${ctx.username || ctx.userId}`);
        const sessions = sessionManager.getActiveSessions();
        const firstSession = sessions[0];
        return firstSession
          ? `**Runtime Status:** Online\n**Active Sessions:** ${sessions.length}\n**Latest Session:** ${firstSession.id}\n**Mode:** ${config.mode}\n**Workspace:** ${workspacePath}`
          : `**Runtime Status:** Online\n**No active session\n**Mode:** ${config.mode}`;
      },
    });
    commandRouter.register({
      command: 'balance',
      description: 'Show wallet balances',
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /balance from user ${ctx.username || ctx.userId}`);
        const walletManager = runtime.getWalletManager();
        if (!walletManager) return 'Wallet not configured.';
        try {
          const balances = await walletManager.getBalances();
          if (balances.length === 0) return 'No balances found.';
          const lines = balances.map((b: any) => `• **${b.chain}**: ${b.balance} ${b.symbol ?? ''}`);
          return lines.join('\n');
        } catch (err: any) {
          return `Error fetching balances: ${err.message}`;
        }
      },
    });
    commandRouter.register({
      command: 'halt',
      description: 'KILL SWITCH — halt all trading (optionally for one symbol)',
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /halt from user ${ctx.username || ctx.userId}`);
        const reason = ctx.args.length > 0 ? ctx.args.join(' ') : 'Halted via Telegram /halt';
        const scope = 'global' as const;
        haltTool.getHaltState().halt(reason, 'telegram', scope);
        return `🛑 **TRADING HALTED**\nReason: ${reason}\nNo orders will execute until /resume.`;
      },
    });
    commandRouter.register({
      command: 'resume',
      description: 'Lift a trading halt and re-enable order execution',
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /resume from user ${ctx.username || ctx.userId}`);
        const lifted = haltTool.getHaltState().resume();
        return lifted > 0
          ? `▶️ **TRADING RESUMED** — ${lifted} halt(s) lifted.`
          : '▶️ No active halts — trading was not halted.';
      },
    });
    commandRouter.register({
      command: 'kill',
      description: 'Alias for /halt — stop all trading immediately',
      aliases: ['k'],
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /kill from user ${ctx.username || ctx.userId}`);
        const reason = ctx.args.length > 0 ? ctx.args.join(' ') : 'Killed via Telegram /kill';
        haltTool.getHaltState().halt(reason, 'telegram', 'global');
        return `🛑 **TRADING KILLED**\nReason: ${reason}\nNo orders will execute until /resume.`;
      },
    });
    commandRouter.register({
      command: 'portfolio',
      description: 'Show open positions and portfolio summary',
      aliases: ['p'],
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /portfolio from user ${ctx.username || ctx.userId}`);
        const positions = runtime.getStateDb()?.listPositions({ status: 'open' }) ?? [];
        if (positions.length === 0) return 'No open positions.';
        const lines = positions.map((pos: any) => {
          const pnl = pos.unrealizedPnl != null ? ` (PnL: ${pos.unrealizedPnl})` : '';
          return `• **${pos.symbol}**: ${pos.size} @ ${pos.entryPrice}${pnl}`;
        });
        return `**Open Positions (${positions.length}):**\n${lines.join('\n')}`;
      },
    });
    commandRouter.register({
      command: 'approve',
      description: 'Approve the most recent pending trade',
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /approve from user ${ctx.username || ctx.userId}`);
        if (!approvalManager) return 'Approval system not initialized.';
        const handled = approvalManager.handleTextResponse('allow once', ctx.chatId, ctx.userId);
        return handled
          ? 'Trade approved.'
          : 'No pending trades to approve.';
      },
    });
    commandRouter.register({
      command: 'reject',
      description: 'Reject the most recent pending trade',
      handler: async (ctx) => {
        logToFile(logPath, `CommandRouter: /reject from user ${ctx.username || ctx.userId}`);
        if (!approvalManager) return 'Approval system not initialized.';
        const handled = approvalManager.handleTextResponse('deny', ctx.chatId, ctx.userId);
        return handled
          ? 'Trade rejected.'
          : 'No pending trades to reject.';
      },
    });
    tgGateway.setCommandRouter(commandRouter);
    tgGateway.setCallbackRouter(callbackRouter);
    logToFile(logPath, 'CommandRouter and CallbackRouter initialized');

    agent.setToolApprovalHandler(async (call, definition) => {
      if (!approvalManager || activeTelegramApprovalChatId === null) {
        return true;
      }

      const command = `${definition.name}:${JSON.stringify(call.args)}`;
      const choice = await approvalManager.requestApproval(
        activeTelegramApprovalChatId,
        command,
        (definition.riskLevel ?? 'medium') as 'low' | 'medium' | 'high' | 'critical',
        definition.description,
      );
      return choice !== 'deny';
    });

    // Route callback queries: CallbackRouter first, then fall through to ApprovalManager
    tgGateway.onCallbackQuery(async (cb) => {
      logToFile(logPath, `Telegram callback query from ${cb.username || cb.userId}: ${cb.text}`);
      try {
        // Try CallbackRouter first
        const routerConsumed = await callbackRouter.handle({
          callbackQueryId: cb.callbackQueryId,
          chatId: cb.chatId,
          messageId: cb.messageId,
          userId: cb.userId,
          data: cb.text,
          payload: cb.text,
        });
        if (routerConsumed) {
          await tgGateway!.answerCallbackQuery(cb.callbackQueryId, routerConsumed.text);
          if (routerConsumed.editMessage) {
            await tgGateway!.editMarkdown(String(cb.chatId), cb.messageId, routerConsumed.editMessage).catch(() => {});
          }
          return;
        }

        // Fall through to ApprovalManager
        const consumed = approvalManager!.handleCallbackQuery(cb.text, cb.userId);
        if (consumed) {
          await tgGateway!.answerCallbackQuery(cb.callbackQueryId, 'Processed');
        } else {
          await tgGateway!.answerCallbackQuery(cb.callbackQueryId);
        }
      } catch (err: any) {
        logToFile(logPath, `Callback query error: ${err.message}`);
        await tgGateway!.answerCallbackQuery(cb.callbackQueryId, 'Error processing').catch(() => {});
      }
    });

    const processTelegramMessage = async (msg: TelegramMessage): Promise<void> => {
      logToFile(logPath, `Telegram message from ${msg.username || msg.userId}: ${msg.text}`);
      let inboundText = msg.text;
      let progress: { chatId: number; messageId: number } | null = null;

      try {
        if (msg.voice) {
          if (!voiceTranscription) {
            await tgGateway!.send(String(msg.chatId), 'Voice messages require OPENAI_API_KEY.');
            return;
          }
          const audio = await tgGateway!.downloadFile(msg.voice.fileId);
          const transcription = await voiceTranscription.execute({
            tool: 'voice_transcribe',
            args: { audioBase64: Buffer.from(audio).toString('base64'), filename: 'telegram-voice.ogg' },
            correlationId: `tg-voice-${msg.messageId}`,
          });
          if (!transcription.success) {
            await tgGateway!.send(String(msg.chatId), `Voice transcription failed: ${transcription.error ?? 'unknown error'}`);
            return;
          }
          inboundText = String((transcription.data as { text: string }).text);
        }

        // Route /commands through CommandRouter (skip agent chat for handled commands)
        if (!msg.voice && inboundText.startsWith('/')) {
          const response = await commandRouter.handle(
            msg.chatId,
            inboundText,
            msg.userId,
            msg.username,
            msg.messageId,
          );
          if (response !== null) {
            await tgGateway!.send(String(msg.chatId), response);
            logToFile(logPath, `CommandRouter handled: ${inboundText}`);
            return;
          }
        }

        // Get or create session for this chat
        const chatKey = `tg-${msg.chatId}`;
        let session = sessionManager.getSessionsByUser(chatKey)[0];
        if (!session) {
          const sessionId = await sessionManager.createSession(chatKey, 'telegram-account', {
            permissions: ['*'],
            riskLevel: 'medium',
          });
          await sessionManager.connectSession(sessionId);
          session = sessionManager.getSession(sessionId)!;
          logToFile(logPath, `Created new session for chat ${msg.chatId}: ${sessionId}`);
        }

        activeTelegramApprovalChatId = msg.chatId;
        progress = await tgGateway!.sendMarkdown(String(msg.chatId), 'Thinking...');

        const chatResult = await agent.chat(inboundText, buildTelegramChatOptions(chatKey));

        const reply = requireVisibleResponse(
          chatResult.content,
          chatResult.reasoningContent,
          `Telegram reply for chat ${msg.chatId}`,
          showThinking,
        );
        const media = extractMediaPaths(reply);
        const visibleReply = media.text || reply;

        if (msg.voice && tts) {
          const speech = await tts.execute({
            tool: 'voice_synthesize',
            args: { text: visibleReply },
            correlationId: `tg-tts-${msg.messageId}`,
          });
          if (speech.success) {
            await tgGateway!.sendVoice(
              String(msg.chatId),
              Buffer.from(String((speech.data as { audioBase64: string }).audioBase64), 'base64'),
            );
          } else if (progress) {
            await tgGateway!.editMarkdown(String(msg.chatId), progress.messageId, visibleReply);
          } else {
            await tgGateway!.sendMarkdown(String(msg.chatId), visibleReply);
          }
        } else if (progress) {
          await tgGateway!.editMarkdown(String(msg.chatId), progress.messageId, visibleReply);
        } else {
          await tgGateway!.sendMarkdown(String(msg.chatId), visibleReply);
        }

        for (const mediaPath of media.mediaPaths) {
          try {
            if (!existsSync(mediaPath)) {
              logToFile(logPath, `MEDIA path missing: ${mediaPath}`);
              continue;
            }
            const bytes = new Uint8Array(readFileSync(mediaPath));
            const caption = basename(mediaPath);
            await tgGateway!.sendMediaFromBuffer(String(msg.chatId), bytes, basename(mediaPath), caption);
          } catch (mediaError: any) {
            logToFile(logPath, `MEDIA delivery failed for ${mediaPath}: ${mediaError.message}`);
          }
        }

        if (session) {
          await sessionManager.processMessage(session.id, {
            channel: 'telegram',
            senderId: String(msg.userId),
            sessionId: session.id,
            text: inboundText,
            trusted: true,
            metadata: { messageId: msg.messageId, username: msg.username },
          });
        }
      } catch (err: any) {
        logToFile(logPath, `Telegram error: ${err.message}`);
        if (progress) {
          await tgGateway!.editMarkdown(String(msg.chatId), progress.messageId, `Error: ${err.message}`).catch(() => {});
        } else {
          await tgGateway!.send(String(msg.chatId), `Error: ${err.message}`).catch(() => {});
        }
      } finally {
        activeTelegramApprovalChatId = null;
      }
    };

    let telegramTurnQueue = Promise.resolve();
    tgGateway.onMessage((msg) => {
      pendingTelegramTurns++;
      telegramTurnQueue = telegramTurnQueue
        .then(() => processTelegramMessage(msg))
        .catch((err) => {
          logToFile(logPath, `Telegram queue error: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { pendingTelegramTurns--; });
    });
  } else {
    logToFile(logPath, 'Telegram gateway: not configured');
  }

  // --- Start Discord Gateway (if token configured) ---
  let dcGateway: DiscordGateway | null = null;

  if (gatewayConfig.discord.enabled) {
    dcGateway = new DiscordGateway();
    if (!gatewayConfig.discord.token || !gatewayConfig.discord.clientId) {
      throw new Error('Discord gateway is enabled but DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID is missing');
    }
    await dcGateway.initialize({ token: gatewayConfig.discord.token, clientId: gatewayConfig.discord.clientId });
    await dcGateway.start();
    logToFile(logPath, 'Discord gateway started');
    console.log('Discord gateway: connected');

    const processDiscordMessage = async (msg: { id: string; channelId: string; content: string; author: { id: string; username: string } }): Promise<void> => {
      logToFile(logPath, `Discord message from ${msg.author.username}: ${msg.content}`);
      try {
        // Get or create session for this channel
        const channelKey = `dc-${msg.channelId}`;
        let session = sessionManager.getSessionsByUser(channelKey)[0];
        if (!session) {
          const sessionId = await sessionManager.createSession(channelKey, 'discord-account', {
            permissions: ['*'],
            riskLevel: 'medium',
          });
          await sessionManager.connectSession(sessionId);
          session = sessionManager.getSession(sessionId)!;
        }

        const chatResult = await agent.chat(msg.content, { sessionId: channelKey });

        const reply = requireVisibleResponse(
          chatResult.content,
          chatResult.reasoningContent,
          `Discord reply for ${msg.channelId}`,
          showThinking,
        );

        await dcGateway!.sendMessage(msg.channelId, reply);

        // Update session activity
        if (session) {
          await sessionManager.processMessage(session.id, {
            channel: 'discord',
            senderId: msg.author.id,
            sessionId: session.id,
            text: msg.content,
            trusted: true,
            metadata: { messageId: msg.id, username: msg.author.username },
          });
        }
      } catch (err: any) {
        logToFile(logPath, `Discord error: ${err.message}`);
        await dcGateway!.sendMessage(msg.channelId, `Error: ${err.message}`).catch(() => {});
      }
    };

    let discordTurnQueue = Promise.resolve();
    dcGateway.onMessage((msg) => {
      pendingDiscordTurns++;
      discordTurnQueue = discordTurnQueue
        .then(() => processDiscordMessage(msg))
        .catch((err) => {
          logToFile(logPath, `Discord queue error: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { pendingDiscordTurns--; });
    });
  } else {
    logToFile(logPath, 'Discord gateway: not configured');
  }

  // --- Deliver new inbox entries to explicitly configured operator channels ---
  const inboxTelegramChatId = process.env['INBOX_TELEGRAM_CHAT_ID'];
  const inboxDiscordChannelId = process.env['INBOX_DISCORD_CHANNEL_ID'];
  runtime.getEventBus().on('inbox', async (event: any) => {
    const entry = event?.payload as { id?: string; title?: string; source?: string } | undefined;
    if (!entry?.id || !entry.title) return;
    const message = `[Inbox] ${entry.title}${entry.source ? ` (${entry.source})` : ''}\nID: ${entry.id}`;
    if (inboxTelegramChatId && tgGateway) {
      await tgGateway.send(inboxTelegramChatId, message).catch((err: Error) => logToFile(logPath, `Inbox Telegram delivery failed: ${err.message}`));
    }
    if (inboxDiscordChannelId && dcGateway) {
      await dcGateway.sendMessage(inboxDiscordChannelId, message).catch((err: Error) => logToFile(logPath, `Inbox Discord delivery failed: ${err.message}`));
    }
  });

  // --- Wire CronEngine delivery to Telegram ---
  cronEngine.on('delivery', async (data: { jobId: string; jobName: string; target: string; chatId?: string; content: string; timestamp: Date }) => {
    logToFile(logPath, `Cron delivery: ${data.jobName} -> ${data.target} (chatId: ${data.chatId})`);

    if (data.target === 'telegram' && data.chatId && tgGateway) {
      try {
        await tgGateway.send(data.chatId, data.content);
        logToFile(logPath, `Cron delivery sent to Telegram chat ${data.chatId}`);
      } catch (err: any) {
        logToFile(logPath, `Cron delivery to Telegram failed: ${err.message}`);
      }
    } else if (data.target === 'discord' && data.chatId && dcGateway) {
      try {
        await dcGateway.sendMessage(data.chatId, data.content);
        logToFile(logPath, `Cron delivery sent to Discord channel ${data.chatId}`);
      } catch (err: any) {
        logToFile(logPath, `Cron delivery to Discord failed: ${err.message}`);
      }
    } else if (data.target === 'local' || !data.target) {
      // Log locally as fallback
      logToFile(logPath, `Cron output (${data.jobName}): ${data.content.substring(0, 500)}`);
    }
  });

  // Global crash handlers — catch anything that slips through
  process.on('uncaughtException', (error) => {
    logToFile(logPath, `[FATAL] Uncaught exception: ${error.message}`);
    console.error('[FATAL] Uncaught exception:', error);
    shutdown('uncaughtException').finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logToFile(logPath, `[FATAL] Unhandled rejection: ${msg}`);
    console.error('[FATAL] Unhandled rejection:', reason);
    shutdown('unhandledRejection').finally(() => process.exit(1));
  });

  // Graceful shutdown with timeout
  const shutdown = async (signal: string) => {
    logToFile(logPath, `Received ${signal}, shutting down...`);
    console.log(`\nReceived ${signal}, shutting down...`);

    // Force exit if shutdown takes too long
    const forceExit = setTimeout(() => {
      logToFile(logPath, 'Shutdown timed out, forcing exit');
      console.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000);

    try {
      // Expire any pending approval requests
      if (approvalManager) {
        approvalManager.expireAll();
      }

      // Drain in-flight turns (with 30s timeout)
      const drainTimeout = 30_000;
      const drainStart = Date.now();
      while (pendingTelegramTurns > 0 || pendingDiscordTurns > 0) {
        if (Date.now() - drainStart > drainTimeout) {
          logToFile(logPath, `[WARN] Drain timeout reached with ${pendingTelegramTurns + pendingDiscordTurns} pending turns`);
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }

      if (tgGateway) await tgGateway.stop().catch(() => {});
      if (dcGateway) await dcGateway.stop().catch(() => {});
      await healthServer.stop();
      await runtime.shutdown();
      // Clean up PID file
      try {
        unlinkSync(pidFilePath);
      } catch { /* ignore */ }
      logToFile(logPath, 'Daemon stopped');
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logToFile(logPath, 'Daemon running, waiting for signals');

  // Keep alive until signal
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Daemon failed:', err);
  process.exit(1);
});
