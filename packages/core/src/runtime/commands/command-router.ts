import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { AuditTrail, Logger } from '@dyna/audit';
import type { AuditEvent } from '@dyna/audit';
import { PermissionRuntime } from '@dyna/permission-runtime';
import type { PermissionContext } from '@dyna/permission-runtime';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SideEffectsSchema = z.object({
  readsMarketData: z.boolean().optional().default(false),
  writesMemory: z.boolean().optional().default(false),
  runsBacktest: z.boolean().optional().default(false),
  runsPaperTrade: z.boolean().optional().default(false),
  runsShadowTrade: z.boolean().optional().default(false),
  runsLiveTrade: z.boolean().optional().default(false),
  modifiesPolicy: z.boolean().optional().default(false),
  modifiesRiskProfile: z.boolean().optional().default(false),
});

const CommandManifestSchema = z.object({
  name: z.string().min(1, 'Command name is required'),
  description: z.string().optional().default(''),
  aliases: z.array(z.string()).optional().default([]),
  permissions: z.array(z.string()).optional().default([]),
  sideEffects: SideEffectsSchema.optional().default({}),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional().default('low'),
  requiresApproval: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SideEffects {
  readsMarketData: boolean;
  writesMemory: boolean;
  runsBacktest: boolean;
  runsPaperTrade: boolean;
  runsShadowTrade: boolean;
  runsLiveTrade: boolean;
  modifiesPolicy: boolean;
  modifiesRiskProfile: boolean;
}

export interface CommandManifest {
  name: string;
  description: string;
  aliases: string[];
  permissions: string[];
  sideEffects: SideEffects;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
}

export type ActorType = 'user' | 'subagent' | 'skill' | 'tool' | 'system';

export type ExecutionMode = 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';

export interface CommandContext {
  actor: string;
  actorType: ActorType;
  args: Record<string, unknown>;
  raw?: string;
  channel?: string;
  mode: ExecutionMode;
}

export interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
  auditId: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

export interface CommandRouterOptions {
  workspacePath: string;
  authConfig?: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CommandNotFoundError extends Error {
  constructor(command: string) {
    super(`Unknown command: "${command}"`);
    this.name = 'CommandNotFoundError';
  }
}

export class PermissionDeniedError extends Error {
  constructor(command: string, reasons: string[]) {
    super(`Permission denied for command "${command}": ${reasons.join('; ')}`);
    this.name = 'PermissionDeniedError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// CommandRouter
// ---------------------------------------------------------------------------

export class CommandRouter {
  private readonly manifests = new Map<string, CommandManifest>();
  private readonly aliasMap = new Map<string, string>();
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly audit: AuditTrail;
  private readonly permission: PermissionRuntime;
  private readonly logger: Logger;
  private readonly workspacePath: string;
  private discovered = false;

  constructor(options: CommandRouterOptions) {
    this.workspacePath = options.workspacePath;
    this.audit = new AuditTrail(options.workspacePath);
    const resolvedAuth = options.authConfig ?? this.loadAuthConfigSync();
    this.permission = new PermissionRuntime(resolvedAuth, options.workspacePath);
    this.logger = new Logger('CommandRouter');
  }

  private loadAuthConfigSync(): Record<string, unknown> {
    const authPath = path.join(this.workspacePath, 'auth.json');
    try {
      // Use Bun's fs for sync read at construction time
      const content = require('fs').readFileSync(authPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Missing or invalid auth configuration at ${authPath}: ${message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /**
   * Discover command manifests from workspace/commands/*.command.json
   */
  async discoverCommands(): Promise<CommandManifest[]> {
    const commandsDir = path.join(this.workspacePath, 'commands');
    const found: CommandManifest[] = [];

    try {
      await fs.access(commandsDir);
    } catch {
      this.logger.info('No commands directory found, skipping discovery');
      this.discovered = true;
      return [];
    }

    const entries = await fs.readdir(commandsDir);

    for (const entry of entries) {
      if (!entry.endsWith('.command.json')) continue;

      const filePath = path.join(commandsDir, entry);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const raw = JSON.parse(content);
        const parsed = CommandManifestSchema.safeParse(raw);

        if (!parsed.success) {
          this.logger.warn(`Invalid command manifest "${entry}": ${parsed.error.message}`);
          continue;
        }

        const manifest = parsed.data;
        this.manifests.set(manifest.name, manifest);

        // Register aliases
        for (const alias of manifest.aliases) {
          this.aliasMap.set(alias, manifest.name);
        }

        found.push(manifest);
        this.logger.info(`Discovered command: ${manifest.name}`);
      } catch (err) {
        this.logger.error(`Failed to load command manifest "${entry}"`, err);
      }
    }

    this.discovered = true;
    return found;
  }

  /**
   * Discover if not yet done, then return all known manifests.
   */
  async getManifests(): Promise<CommandManifest[]> {
    if (!this.discovered) {
      await this.discoverCommands();
    }
    return Array.from(this.manifests.values());
  }

  // -----------------------------------------------------------------------
  // Handler registration
  // -----------------------------------------------------------------------

  /**
   * Register a handler function for a command name.
   */
  registerHandler(name: string, handler: CommandHandler): void {
    if (!name) throw new ValidationError('Handler name must not be empty');
    this.handlers.set(name, handler);
  }

  /**
   * Register a handler for multiple command names at once.
   */
  registerHandlers(map: Record<string, CommandHandler>): void {
    for (const [name, handler] of Object.entries(map)) {
      this.registerHandler(name, handler);
    }
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  /**
   * Resolve a command name or alias to its canonical name.
   */
  resolveCommand(input: string): string | undefined {
    // Direct manifest name match
    if (this.manifests.has(input)) return input;

    // Alias lookup
    const canonical = this.aliasMap.get(input);
    if (canonical) return canonical;

    return undefined;
  }

  /**
   * Execute a command by name (or alias) with the given context.
   *
   * Steps:
   *  1. Discover commands if not yet done
   *  2. Resolve command name / alias
   *  3. Validate the manifest exists
   *  4. Enforce permissions
   *  5. Execute registered handler
   *  6. Audit the execution
   */
  async execute(commandName: string, ctx: CommandContext): Promise<CommandResult> {
    if (!this.discovered) {
      await this.discoverCommands();
    }

    const resolved = this.resolveCommand(commandName);

    if (!resolved) {
      const err = new CommandNotFoundError(commandName);
      const auditId = await this.recordAudit(commandName, ctx, 'rejected', err.message, undefined);
      return { success: false, error: err.message, auditId };
    }

    const manifest = this.manifests.get(resolved)!;

    // Permission check
    const permCtx: PermissionContext = {
      actor: ctx.actor,
      actorType: ctx.actorType,
      action: manifest.name,
      mode: ctx.mode,
      artifact: ctx.args,
    };

    const permissionCheck = await this.permission.checkPermission(permCtx);

    if (!permissionCheck.allowed) {
      const err = new PermissionDeniedError(resolved, permissionCheck.reasons);
      const auditId = await this.recordAudit(resolved, ctx, 'denied', err.message, manifest);
      return { success: false, error: err.message, auditId };
    }

    // Check explicit manifest permissions
    if (manifest.permissions.length > 0) {
      const hasAll = manifest.permissions.every((p) =>
        permissionCheck.reasons.includes(p) || permissionCheck.allowed,
      );
      if (!hasAll) {
        const err = new PermissionDeniedError(resolved, [
          ...permissionCheck.reasons,
          `Missing required permissions: ${manifest.permissions.join(', ')}`,
        ]);
        const auditId = await this.recordAudit(resolved, ctx, 'denied', err.message, manifest);
        return { success: false, error: err.message, auditId };
      }
    }

    // Find and invoke handler
    const handler = this.handlers.get(resolved);

    if (!handler) {
      const msg = `No handler registered for command "${resolved}"`;
      const auditId = await this.recordAudit(resolved, ctx, 'failure', msg, manifest);
      return { success: false, error: msg, auditId };
    }

    try {
      const result = await handler(ctx);
      const auditId = await this.recordAudit(resolved, ctx, result.success ? 'success' : 'failure', result.error, manifest);
      return { ...result, auditId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const auditId = await this.recordAudit(resolved, ctx, 'failure', message, manifest);
      return { success: false, error: message, auditId };
    }
  }

  // -----------------------------------------------------------------------
  // Aliases
  // -----------------------------------------------------------------------

  /**
   * Return all registered aliases mapped to their canonical command names.
   */
  getAliases(): Map<string, string> {
    return new Map(this.aliasMap);
  }

  /**
   * Return all registered handler names.
   */
  getHandlerNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async recordAudit(
    command: string,
    ctx: CommandContext,
    result: 'success' | 'failure' | 'denied' | 'rejected',
    message: string | undefined,
    manifest: CommandManifest | undefined,
  ): Promise<string> {
    const event: Omit<AuditEvent, 'id' | 'timestamp'> = {
      type: 'action',
      actor: ctx.actor,
      actorType: ctx.actorType,
      action: command,
      ...(manifest?.name ? { resource: manifest.name } : {}),
      result,
      details: {
        args: ctx.args,
        raw: ctx.raw,
        channel: ctx.channel,
        mode: ctx.mode,
        riskLevel: manifest?.riskLevel,
        requiresApproval: manifest?.requiresApproval,
        sideEffects: manifest?.sideEffects,
        message,
      },
      metadata: { command, manifestName: manifest?.name },
    };

    await this.audit.record(event);
    // AuditTrail.record creates a uuid internally but doesn't return it,
    // so return a synthetic identifier based on timestamp for the result.
    return `${command}_${Date.now()}`;
  }
}
