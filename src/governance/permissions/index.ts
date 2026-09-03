import { AuthRuntime } from '@dyna/auth-runtime';
import { AuditTrail, Logger } from '@dyna/audit';
import type { AuditEvent } from '@dyna/audit';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type PermissionCheck = {
  allowed: boolean;
  reasons: string[];
  requiredApprovals?: string[];
};

export interface PermissionContext {
  actor: string;
  actorType: 'user' | 'subagent' | 'skill' | 'tool' | 'system';
  action: string;
  resource?: string;
  mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';
  artifact?: any;
}

export class PermissionRuntime {
  private auth: AuthRuntime;
  private audit: AuditTrail;
  private logger = new Logger('PermissionRuntime');
  private readonly workspacePath: string;

  constructor(
    authConfig: any,
    workspacePath: string
  ) {
    this.auth = new AuthRuntime(authConfig);
    this.workspacePath = path.resolve(workspacePath);
    this.audit = new AuditTrail(this.workspacePath);
  }

  async checkPermission(context: PermissionContext): Promise<PermissionCheck> {
    const reasons: string[] = [];
    let requiredApprovals: string[] = [];

    try {
      // Check channel access
      if (!this.auth.canAccessChannel(context.actor, 'cli') &&
          !this.auth.canAccessChannel(context.actor, 'web')) {
        reasons.push('Actor not allowed in any channel');
        await this.recordPermissionDenied(context, reasons);
        return { allowed: false, reasons };
      }

      // Check user permissions
      if (!this.auth.hasPermission(context.actor, context.action)) {
        reasons.push(`Missing permission: ${context.action}`);

        if (this.auth.requiresApproval(context.action)) {
          requiredApprovals.push(context.action);
          reasons.push(`Requires approval: ${context.action}`);
        }
      }

      // Check blocked operations
      if (this.auth.isBlocked(context.action)) {
        reasons.push(`Operation blocked: ${context.action}`);
        await this.recordPermissionDenied(context, reasons);
        return { allowed: false, reasons };
      }

      // Check mode-specific requirements
      if (this.isHighRiskMode(context.mode)) {
        if (!this.hasUserProfile()) {
          reasons.push('USER.md required for this mode');
          await this.recordPermissionDenied(context, reasons);
          return { allowed: false, reasons };
        }
      }

      const allowed = reasons.length === 0 ||
        (context.actor === 'system' && this.isSystemAction(context.action));

      await this.recordPermissionCheck(context, allowed, reasons, requiredApprovals);

      return {
        allowed,
        reasons,
        requiredApprovals: requiredApprovals.length > 0 ? requiredApprovals : undefined
      };

    } catch (error) {
      this.logger.error('Permission check failed', error);
      return {
        allowed: false,
        reasons: ['Permission system error']
      };
    }
  }

  private isHighRiskMode(mode: string): boolean {
    return ['paper', 'shadow', 'micro_live', 'live'].includes(mode);
  }

  private hasUserProfile(): boolean {
    return existsSync(path.join(this.workspacePath, 'USER.md'));
  }

  private isSystemAction(action: string): boolean {
    // Some system actions are allowed bypassing normal checks
    return action.startsWith('system:') || action === 'heartbeat';
  }

  private async recordPermissionCheck(
    context: PermissionContext,
    allowed: boolean,
    reasons: string[],
    requiredApprovals: string[]
  ) {
    await this.audit.record({
      type: 'permission',
      actor: context.actor,
      actorType: context.actorType,
      action: context.action,
      resource: context.resource,
      result: allowed ? 'approved' : 'denied',
      details: {
        reasons,
        requiredApprovals,
        mode: context.mode
      },
      metadata: context
    });
  }

  private async recordPermissionDenied(context: PermissionContext, reasons: string[]) {
    await this.audit.record({
      type: 'permission',
      actor: context.actor,
      actorType: context.actorType,
      action: context.action,
      resource: context.resource,
      result: 'denied',
      details: { reasons },
      metadata: context
    });
  }
}
