import type { PermissionDecision, RiskLevel } from './modes.js';
import { parseJson } from '../utils/json.js';

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  toolName: string;
  input: Record<string, unknown>;
  decision: PermissionDecision;
  userId?: string;
  sessionId?: string;
  durationMs?: number;
}

export interface AuditSummary {
  totalDecisions: number;
  allowedCount: number;
  deniedCount: number;
  approvalRequiredCount: number;
  byRiskLevel: Record<RiskLevel, number>;
  byTool: Record<string, number>;
}

export class AuditLogger {
  private logs: AuditLogEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 10000) {
    this.maxEntries = maxEntries;
  }

  log(entry: Omit<AuditLogEntry, 'id'>): void {
    const fullEntry: AuditLogEntry = {
      ...entry,
      id: this.generateId(),
    };

    this.logs.push(fullEntry);

    if (this.logs.length > this.maxEntries) {
      this.logs.shift();
    }
  }

  getLogs(limit?: number): AuditLogEntry[] {
    if (limit) {
      return this.logs.slice(-limit);
    }
    return [...this.logs];
  }

  getLogsForSession(sessionId: string): AuditLogEntry[] {
    return this.logs.filter((entry) => entry.sessionId === sessionId);
  }

  getLogsForTool(toolName: string): AuditLogEntry[] {
    return this.logs.filter((entry) => entry.toolName === toolName);
  }

  getSummary(): AuditSummary {
    const summary: AuditSummary = {
      totalDecisions: this.logs.length,
      allowedCount: 0,
      deniedCount: 0,
      approvalRequiredCount: 0,
      byRiskLevel: { low: 0, medium: 0, high: 0, critical: 0 },
      byTool: {},
    };

    for (const entry of this.logs) {
      if (entry.decision.allowed) {
        summary.allowedCount++;
      } else {
        summary.deniedCount++;
      }

      if (entry.decision.requiresApproval) {
        summary.approvalRequiredCount++;
      }

      if (entry.decision.riskLevel) {
        summary.byRiskLevel[entry.decision.riskLevel]++;
      }

      summary.byTool[entry.toolName] = (summary.byTool[entry.toolName] || 0) + 1;
    }

    return summary;
  }

  clear(): void {
    this.logs = [];
  }

  exportToJSON(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  importFromJSON(json: string): void {
    const entries = parseJson<AuditLogEntry[]>(json);
    if (entries) {
      this.logs = entries.slice(-this.maxEntries);
    }
  }

  private generateId(): string {
    return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

export function createAuditLogger(maxEntries?: number): AuditLogger {
  return new AuditLogger(maxEntries);
}
