import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from './logger';

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: 'action' | 'decision' | 'error' | 'permission' | 'policy' | 'model_call' | 'tool_call' | 'adapter_call' | 'execution';
  actor: string;
  actorType: 'user' | 'subagent' | 'skill' | 'tool' | 'system';
  action: string;
  resource?: string;
  result: 'success' | 'failure' | 'failed' | 'denied' | 'approved' | 'rejected' | 'running' | 'completed' | 'pending';
  details: any;
  metadata?: any;
}

export class AuditTrail {
  private logger: Logger;
  private auditFile: string;

  constructor(workspacePath: string) {
    this.logger = new Logger('AuditTrail');
    this.auditFile = path.join(workspacePath, 'audit.jsonl');
  }

  async record(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    const auditEvent: AuditEvent = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...event
    };

    const line = JSON.stringify(auditEvent) + '\n';

    try {
      // Ensure audit directory exists
      await fs.mkdir(path.dirname(this.auditFile), { recursive: true });

      // Append to audit log
      await fs.appendFile(this.auditFile, line);

      this.logger.info(`Audit event recorded: ${event.type} - ${event.action}`, {
        eventId: auditEvent.id,
        actor: event.actor,
        result: event.result
      });
    } catch (error) {
      this.logger.error('Failed to write audit log', { error, eventId: auditEvent.id });
      throw error;
    }
  }

  async getEvents(filter?: {
    actor?: string;
    type?: AuditEvent['type'];
    result?: AuditEvent['result'];
    since?: string;
    limit?: number;
  }): Promise<AuditEvent[]> {
    try {
      await fs.access(this.auditFile);
    } catch {
      // No audit file exists
      return [];
    }

    const content = await fs.readFile(this.auditFile, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line);

    let events = lines.map(line => {
      try {
        return JSON.parse(line) as AuditEvent;
      } catch {
        return null;
      }
    }).filter(Boolean) as AuditEvent[];

    // Apply filters
    if (filter) {
      if (filter.actor) {
        events = events.filter(e => e.actor === filter.actor);
      }
      if (filter.type) {
        events = events.filter(e => e.type === filter.type);
      }
      if (filter.result) {
        events = events.filter(e => e.result === filter.result);
      }
      if (filter.since) {
        events = events.filter(e => e.timestamp >= filter.since!);
      }
      if (filter.limit) {
        events = events.slice(-filter.limit);
      }
    }

    return events;
  }

  async searchEvents(query: string): Promise<AuditEvent[]> {
    const events = await this.getEvents();

    return events.filter(event => {
      const searchText = `${event.action} ${event.details || ''} ${event.resource || ''}`.toLowerCase();
      return searchText.includes(query.toLowerCase());
    });
  }

  async getEventSummary(): Promise<{
    totalEvents: number;
    eventsByType: { [key in AuditEvent['type']]?: number };
    eventsByResult: { [key in AuditEvent['result']]?: number };
    lastEvent: string | null;
  }> {
    const events = await this.getEvents();

    const eventsByType: Partial<Record<AuditEvent['type'], number>> = {};
    const eventsByResult: Partial<Record<AuditEvent['result'], number>> = {};

    for (const event of events) {
      eventsByType[event.type] = (eventsByType[event.type] ?? 0) + 1;
      eventsByResult[event.result] = (eventsByResult[event.result] ?? 0) + 1;
    }

    return {
      totalEvents: events.length,
      eventsByType,
      eventsByResult,
      lastEvent: events.length > 0 ? events[events.length - 1]!.timestamp : null
    };
  }
}