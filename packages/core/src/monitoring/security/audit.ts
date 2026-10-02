/**
 * Security Audit Module
 *
 * Tracks all security events, provides audit trails, and detects suspicious activities
 */

import Emittery from 'emittery';
import { MemoryStoreImpl } from '@dyna/memory-core';
import crypto from 'crypto';

export type AuditEventType =
  | 'AUTH_SUCCESS'
  | 'AUTH_FAILURE'
  | 'AUTH_LOCKOUT'
  | 'LOGOUT'
  | 'PERMISSION_DENIED'
  | 'API_KEY_CREATED'
  | 'API_KEY_DELETED'
  | 'API_KEY_USED'
  | 'ORDER_CREATE'
  | 'ORDER_MODIFY'
  | 'ORDER_CANCEL'
  | 'STRATEGY_CREATE'
  | 'STRATEGY_EXECUTE'
  | 'RISK_POLICY_TRIGGER'
  | 'EMERGENCY_STOP'
  | 'SUSPICIOUS_IP'
  | 'MALICIOUS_INPUT'
  | 'PERMISSION_ESCALATION'
  | 'DATA_EXPORT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'ERROR'
  | 'SUSPICIOUS_PATTERN';

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  userId: string;
  sessionId?: string;
  ipAddress: string;
  userAgent?: string;
  resourceId?: string;
  action: string;
  details: Record<string, any>;
  timestamp: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
}

export interface AuditTrail {
  events: AuditEvent[];
  totalEvents: number;
  timeRange: {
    start: number;
    end: number;
  };
  filteredBy: {
    userId?: string;
    type?: AuditEventType;
    severity?: AuditEvent['severity'];
    start?: number;
    end?: number;
    ipAddress?: string;
  };
}

export interface SuspiciousPattern {
  pattern: string;
  description: string;
  threshold: number;
  timeWindow: number;
  severity: 'warning' | 'error' | 'critical';
  action: 'alert' | 'block' | 'escalate';
}

export class AuditService extends Emittery<Record<string, unknown>> {
  private memory: MemoryStoreImpl;
  private suspiciousPatterns: SuspiciousPattern[] = [
    {
      pattern: 'AUTH_FAILURE',
      description: 'Multiple failed login attempts',
      threshold: 5,
      timeWindow: 300000, // 5 minutes
      severity: 'warning',
      action: 'alert',
    },
    {
      pattern: 'SUSPICIOUS_IP',
      description: 'Login from unusual geographic location',
      threshold: 1,
      timeWindow: 60000, // 1 minute
      severity: 'critical',
      action: 'block',
    },
    {
      pattern: 'PERMISSION_ESCALATION',
      description: 'Unauthorized permission access attempts',
      threshold: 3,
      timeWindow: 300000, // 5 minutes
      severity: 'critical',
      action: 'escalate',
    },
    {
      pattern: 'MALICIOUS_INPUT',
      description: 'Malicious input detected',
      threshold: 1,
      timeWindow: 60000, // 1 minute
      severity: 'error',
      action: 'block',
    },
    {
      pattern: 'ORDER_MODIFY',
      description: 'Frequent order modifications',
      threshold: 10,
      timeWindow: 60000, // 1 minute
      severity: 'warning',
      action: 'alert',
    },
  ];

  constructor(memory: MemoryStoreImpl) {
    super();
    this.memory = memory;
  }

  /**
   * Log audit event
   */
  async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    const auditEvent: AuditEvent = {
      ...event,
      id: this.generateEventId(),
      timestamp: Date.now(),
    };

    // Store event
    await this.memory.setAuditEvent(auditEvent.id, auditEvent);

    // Check for suspicious patterns
    await this.checkSuspiciousPatterns(auditEvent);

    // Emit event
    this.emit('audit_event', auditEvent);

    // Check if we need to archive old events
    await this.checkArchive();
  }

  /**
   * Get audit trail with filtering
   */
  async getAuditTrail(filters: {
    userId?: string;
    type?: AuditEventType;
    severity?: AuditEvent['severity'];
    start?: number;
    end?: number;
    ipAddress?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<AuditTrail> {
    const events = await this.memory.getAuditEvents(filters) as AuditEvent[];
    const totalEvents = await this.memory.getAuditEventCount(filters);

    let timeRange = { start: 0, end: Date.now() };
    if (events.length > 0) {
      timeRange = {
        start: events[0]!.timestamp,
        end: events[events.length - 1]!.timestamp,
      };
    }

    return {
      events,
      totalEvents,
      timeRange,
      filteredBy: filters,
    };
  }

  /**
   * Get user activity summary
   */
  async getUserActivity(userId: string, days: number = 7): Promise<{
    totalEvents: number;
    byType: Partial<Record<AuditEventType, number>>;
    bySeverity: Record<AuditEvent['severity'], number>;
    lastActivity: number;
    suspiciousActivity: number;
  }> {
    const start = Date.now() - days * 24 * 60 * 60 * 1000;
    const events = (await this.memory.getAuditEvents({
      userId,
      start,
    })) as AuditEvent[];

    const byType: Partial<Record<AuditEventType, number>> = {};
    const bySeverity: Record<AuditEvent['severity'], number> = {
      info: 0,
      warning: 0,
      error: 0,
      critical: 0,
    };

    events.forEach(event => {
      byType[event.type] = (byType[event.type] || 0) + 1;
      bySeverity[event.severity]++;
    });

    return {
      totalEvents: events.length,
      byType,
      bySeverity,
      lastActivity: events.length > 0 ? events[events.length - 1]!.timestamp : 0,
      suspiciousActivity: events.filter(e => e.severity === 'warning' || e.severity === 'critical').length,
    };
  }

  /**
   * Generate security report
   */
  async generateSecurityReport(days: number = 30): Promise<{
    summary: {
      totalEvents: number;
      uniqueUsers: number;
      suspiciousEvents: number;
      blockedAttempts: number;
      securityScore: number;
    };
    topThreats: {
      type: AuditEventType;
      count: number;
      percentage: number;
    }[];
    suspiciousIPs: {
      ipAddress: string;
      attempts: number;
      lastSeen: number;
      actions: string[];
    }[];
    recommendations: string[];
  }> {
    const start = Date.now() - days * 24 * 60 * 60 * 1000;

    // Get all events
    const events = (await this.memory.getAuditEvents({ start })) as AuditEvent[];

    // Analyze data
    const uniqueUsers = new Set(events.map(e => e.userId));
    const suspiciousEvents = events.filter(e => e.severity === 'warning' || e.severity === 'critical');

    // Analyze IP addresses
    const ipActivity = new Map<string, {
      count: number;
      lastSeen: number;
      actions: Set<string>;
    }>();

    events.forEach(event => {
      if (!ipActivity.has(event.ipAddress)) {
        ipActivity.set(event.ipAddress, {
          count: 0,
          lastSeen: event.timestamp,
          actions: new Set(),
        });
      }
      const ip = ipActivity.get(event.ipAddress)!;
      ip.count++;
      ip.lastSeen = Math.max(ip.lastSeen, event.timestamp);
      ip.actions.add(event.action);
    });

    // Find suspicious IPs
    const suspiciousIPs = Array.from(ipActivity.entries())
      .filter(([_, data]) => data.count > 10 || data.actions.has('AUTH_FAILURE'))
      .map(([ip, data]) => ({
        ipAddress: ip,
        attempts: data.count,
        lastSeen: data.lastSeen,
        actions: Array.from(data.actions),
      }));

    // Calculate security score (0-100)
    const securityScore = Math.max(0, 100 - (suspiciousEvents.length / events.length) * 100);

    // Generate recommendations
    const recommendations = this.generateRecommendations(events, suspiciousIPs);

    // Get top threats
    const threatCounts = events.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {} as Record<AuditEventType, number>);

    const topThreats = (Object.entries(threatCounts) as [string, number][])
      .map(([type, count]) => ({
        type: type as AuditEventType,
        count,
        percentage: (count / events.length) * 100,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      summary: {
        totalEvents: events.length,
        uniqueUsers: uniqueUsers.size,
        suspiciousEvents: suspiciousEvents.length,
        blockedAttempts: events.filter(e => e.action === 'BLOCKED').length,
        securityScore: Math.round(securityScore),
      },
      topThreats,
      suspiciousIPs,
      recommendations,
    };
  }

  /**
   * Check for suspicious patterns
   */
  private async checkSuspiciousPatterns(event: AuditEvent): Promise<void> {
    for (const pattern of this.suspiciousPatterns) {
      if (event.type === pattern.pattern || event.type.includes(pattern.pattern)) {
        const recentEvents = (await this.memory.getAuditEvents({
          userId: event.userId,
          type: pattern.pattern as AuditEventType,
          start: Date.now() - pattern.timeWindow,
        })) as AuditEvent[];

        if (recentEvents.length >= pattern.threshold) {
          // Pattern detected
          const alertEvent: Omit<AuditEvent, 'id' | 'timestamp'> = {
            ...event,
            type: 'SUSPICIOUS_PATTERN' as AuditEventType,
            severity: pattern.severity,
            details: {
              pattern: pattern.pattern,
              detected: true,
              threshold: pattern.threshold,
              timeWindow: pattern.timeWindow,
              action: pattern.action,
            },
          };

          await this.logEvent(alertEvent);

          // Take action based on pattern
          if (pattern.action === 'block') {
            this.emit('security_block', {
              userId: event.userId,
              reason: pattern.description,
              event,
            });
          } else if (pattern.action === 'escalate') {
            this.emit('security_escalate', {
              userId: event.userId,
              reason: pattern.description,
              event,
            });
          }
        }
      }
    }
  }

  /**
   * Check if archive is needed
   */
  private async checkArchive(): Promise<void> {
    // Archive events older than 90 days
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const oldEvents = (await this.memory.getAuditEvents({
      end: cutoff,
      limit: 1000,
    })) as AuditEvent[];

    if (oldEvents.length > 0) {
      // Archive these events
      await this.memory.archiveAuditEvents(oldEvents.length > 0 ? oldEvents[oldEvents.length - 1]!.timestamp : Date.now());

      // Emit archive event
      this.emit('events_archived', {
        count: oldEvents.length,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Generate security recommendations
   */
  private generateRecommendations(events: AuditEvent[], suspiciousIPs: any[]): string[] {
    const recommendations: string[] = [];

    // Check for failed logins
    const failedLogins = events.filter(e => e.type === 'AUTH_FAILURE');
    if (failedLogins.length > 100) {
      recommendations.push('Implement account lockout after multiple failed attempts');
    }

    // Check for suspicious IPs
    if (suspiciousIPs.length > 0) {
      recommendations.push(`Monitor suspicious IP addresses: ${suspiciousIPs.slice(0, 5).map(ip => ip.ip).join(', ')}`);
    }

    // Check for permission escalation attempts
    const permissionEscalations = events.filter(e => e.type === 'PERMISSION_ESCALATION');
    if (permissionEscalations.length > 10) {
      recommendations.push('Implement stricter permission validation');
    }

    // Check for order modifications
    const orderMods = events.filter(e => e.type === 'ORDER_MODIFY');
    if (orderMods.length > 1000) {
      recommendations.push('Consider implementing rate limiting for order modifications');
    }

    return recommendations;
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return `audit_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
}