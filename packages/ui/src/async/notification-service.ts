/**
 * Notification Service - Multi-channel task completion notifications
 * Supports email, Telegram, webhooks, and console logging
 */

import type { Task } from './task-queue.js';
import { getErrorMessage } from '../utils/index.js';
import { postWebhook } from './safe-webhook.js';

export type NotificationChannel = 'email' | 'telegram' | 'webhook' | 'console';

export interface NotificationConfig {
  channels: NotificationChannel[];
  email?: {
    provider: 'smtp' | 'sendgrid' | 'mailgun';
    from: string;
    smtpConfig?: {
      host: string;
      port: number;
      user: string;
      password: string;
    };
    apiKey?: string; // For SendGrid/Mailgun
  };
  telegram?: {
    botToken: string;
    chatId: string;
  };
  console?: {
    verbose?: boolean;
  };
}

export interface NotificationTemplate {
  name: string;
  subject?: string;
  body: string;
}

export interface NotificationEvent {
  taskId: string;
  event: 'started' | 'completed' | 'failed' | 'cancelled';
  task: Task;
  timestamp: number;
  message?: string;
}

export interface SubagentNotification {
  type: 'subagent_started' | 'subagent_completed' | 'subagent_failed' | 'subagent_tool_call';
  taskId: string;
  agentName: string;
  resultPath?: string;
  toolName?: string;
  result?: string;
  error?: string;
  timestamp: Date;
}

/**
 * Notification Service Implementation
 */
export class NotificationService {
  private config: NotificationConfig;
  private templates: Map<string, NotificationTemplate> = new Map();
  private emailSender?: EmailSender;
  private telegramSender?: TelegramSender;

  constructor(config: NotificationConfig) {
    this.config = config;
    this.initializeSenders();
    this.loadDefaultTemplates();
  }

  /**
   * Initialize notification senders
   */
  private initializeSenders(): void {
    if (this.config.channels.includes('email') && this.config.email) {
      this.emailSender = new EmailSender(this.config.email);
    }

    if (this.config.channels.includes('telegram') && this.config.telegram) {
      this.telegramSender = new TelegramSender(this.config.telegram);
    }
  }

  /**
   * Load default notification templates
   */
  private loadDefaultTemplates(): void {
    this.templates.set('task_completed', {
      name: 'task_completed',
      subject: 'Task Completed: {{taskId}}',
      body: `Task {{taskId}} has completed successfully.

Type: {{taskType}}
Status: {{status}}
Execution Time: {{executionTime}}ms
Result: {{result}}

Timestamp: {{timestamp}}`,
    });

    this.templates.set('task_failed', {
      name: 'task_failed',
      subject: 'Task Failed: {{taskId}}',
      body: `Task {{taskId}} has failed.

Type: {{taskType}}
Status: {{status}}
Error: {{error}}
Retries: {{retries}}/{{maxRetries}}

Timestamp: {{timestamp}}`,
    });

    this.templates.set('task_started', {
      name: 'task_started',
      subject: 'Task Started: {{taskId}}',
      body: `Task {{taskId}} has started execution.

Type: {{taskType}}
Priority: {{priority}}

Timestamp: {{timestamp}}`,
    });

    this.templates.set('task_cancelled', {
      name: 'task_cancelled',
      subject: 'Task Cancelled: {{taskId}}',
      body: `Task {{taskId}} was cancelled.

Type: {{taskType}}
Reason: User cancelled

Timestamp: {{timestamp}}`,
    });

    // Subagent-specific templates
    this.templates.set('subagent_started', {
      name: 'subagent_started',
      subject: 'Subagent Started: {{agentName}}',
      body: `Subagent '{{agentName}}' has started execution.

Task ID: {{taskId}}
Timestamp: {{timestamp}}`,
    });

    this.templates.set('subagent_completed', {
      name: 'subagent_completed',
      subject: 'Subagent Completed: {{agentName}}',
      body: `Subagent '{{agentName}}' has completed.

Task ID: {{taskId}}
Result Path: {{resultPath}}

Result:
{{result}}

Timestamp: {{timestamp}}`,
    });

    this.templates.set('subagent_failed', {
      name: 'subagent_failed',
      subject: 'Subagent Failed: {{agentName}}',
      body: `Subagent '{{agentName}}' has failed.

Task ID: {{taskId}}
Error: {{error}}

Timestamp: {{timestamp}}`,
    });
  }

  /**
   * Queue of pending subagent notifications for agent context
   */
  private pendingSubagentNotifications: SubagentNotification[] = [];

  /**
   * Notify about subagent event
   * Can be used to wake up the main agent
   */
  notifySubagent(notification: SubagentNotification): void {
    this.pendingSubagentNotifications.push(notification);

    // Log to console if configured
    if (this.config.channels.includes('console')) {
      const prefix = {
        subagent_started: '[SUBAGENT STARTED]',
        subagent_completed: '[SUBAGENT COMPLETED]',
        subagent_failed: '[SUBAGENT FAILED]',
        subagent_tool_call: '[SUBAGENT TOOL]',
      }[notification.type];

      console.log(`${prefix} ${notification.agentName} (${notification.taskId.slice(0, 8)})`);
      if (notification.resultPath) {
        console.log(`   Result at: ${notification.resultPath}`);
      }
      if (notification.error) {
        console.log(`   Error: ${notification.error}`);
      }
    }
  }

  /**
   * Get and clear pending subagent notifications
   * Call this to check for completed subagents
   */
  getPendingSubagentNotifications(): SubagentNotification[] {
    const notifications = [...this.pendingSubagentNotifications];
    this.pendingSubagentNotifications = [];
    return notifications;
  }

  /**
   * Check if there are pending subagent notifications
   */
  hasPendingSubagentNotifications(): boolean {
    return this.pendingSubagentNotifications.length > 0;
  }

  /**
   * Send notification for task event
   */
  async notify(event: NotificationEvent): Promise<void> {
    // Determine template based on event
    const templateName = `task_${event.event}`;
    const template = this.templates.get(templateName);

    if (!template) {
      console.warn(`No template found for event: ${event.event}`);
      return;
    }

    // Prepare template variables
    const variables = this.prepareTemplateVariables(event);

    // Send via configured channels
    const results: Promise<void>[] = [];

    for (const channel of this.config.channels) {
      switch (channel) {
        case 'email':
          if (this.emailSender) {
            results.push(
              this.emailSender.send({
                to: variables.recipientEmail || 'notifications@example.com',
                subject: this.fillTemplate(template.subject || '', variables),
                body: this.fillTemplate(template.body, variables),
              })
            );
          }
          break;

        case 'telegram':
          if (this.telegramSender) {
            results.push(
              this.telegramSender.send({
                text: this.formatTelegramMessage(event, variables),
              })
            );
          }
          break;

        case 'webhook':
          if (variables.webhookUrl) {
            results.push(this.sendWebhook(event, variables));
          }
          break;

        case 'console':
          this.logToConsole(event, variables);
          break;
      }
    }

    // Wait for all notifications to complete
    const errors: string[] = [];
    for (const result of results) {
      try {
        await result;
      } catch (error) {
        errors.push(getErrorMessage(error));
      }
    }

    if (errors.length > 0) {
      console.warn('Notification errors:', errors);
    }
  }

  /**
   * Prepare template variables from task event
   */
  private prepareTemplateVariables(event: NotificationEvent): Record<string, string> {
    const executionTime = event.task.completedAt
      ? event.task.completedAt - (event.task.startedAt || event.task.createdAt)
      : 0;

    return {
      taskId: event.task.id,
      taskType: event.task.type,
      priority: event.task.priority.toString(),
      status: event.task.status,
      error: event.task.error || '',
      result: this.formatResult(event.task.result),
      message: event.message || '',
      executionTime: executionTime.toString(),
      timestamp: new Date(event.timestamp).toISOString(),
      retries: event.task.retries.toString(),
      maxRetries: event.task.maxRetries.toString(),
      recipientEmail: (event.task.payload.context?.email as string) || '',
      webhookUrl: (event.task.payload.context?.webhookUrl as string) || '',
    };
  }

  /**
   * Fill template with variables
   */
  private fillTemplate(template: string, variables: Record<string, string>): string {
    let result = template;

    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      result = result.replace(new RegExp(placeholder, 'g'), value);
    }

    return result;
  }

  /**
   * Format result for display
   */
  private formatResult(result: unknown): string {
    if (!result) return 'No result';
    if (typeof result === 'string') return result;
    if (typeof result === 'object') {
      try {
        return JSON.stringify(result, null, 2);
      } catch {
        return String(result);
      }
    }
    return String(result);
  }

  /**
   * Format message for Telegram
   */
  private formatTelegramMessage(
    event: NotificationEvent,
    variables: Record<string, string>
  ): string {
    const emoji =
      {
        completed: 'OK',
        failed: 'ERROR',
        started: 'RUNNING',
        cancelled: 'CANCELLED',
      }[event.event] || 'INFO';

    return `${emoji} Task ${event.event}: *${event.task.id}*\nType: ${event.task.type}\nStatus: ${event.task.status}`;
  }

  /**
   * Send webhook notification
   */
  private async sendWebhook(
    event: NotificationEvent,
    variables: Record<string, string>
  ): Promise<void> {
    const webhookUrl = variables.webhookUrl;
    if (!webhookUrl) return;

    try {
      const response = await postWebhook(webhookUrl, {
        taskId: event.task.id,
        event: event.event,
        status: event.task.status,
        result: event.task.result,
        error: event.task.error,
        timestamp: event.timestamp,
      }, {
        'X-Task-ID': event.task.id,
        'X-Event': event.event,
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Webhook notification failed: ${getErrorMessage(error)}`, { cause: error });
    }
  }

  /**
   * Log to console
   */
  private logToConsole(event: NotificationEvent, variables: Record<string, string>): void {
    const emoji =
      {
        completed: 'OK',
        failed: 'ERROR',
        started: 'RUNNING',
        cancelled: 'CANCELLED',
      }[event.event] || 'INFO';

    console.log(
      `${emoji} [${event.event.toUpperCase()}] ${event.task.id} (${event.task.type}): ${event.task.status}`
    );

    if (this.config.console?.verbose) {
      console.log(`   Execution Time: ${variables.executionTime}ms`);
      if (event.task.error) {
        console.log(`   Error: ${event.task.error}`);
      }
    }
  }

  /**
   * Register custom template
   */
  registerTemplate(template: NotificationTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * Test notification
   */
  async test(channel: NotificationChannel): Promise<void> {
    const testEvent: NotificationEvent = {
      taskId: 'test_task_123',
      event: 'completed',
      task: {
        id: 'test_task_123',
        type: 'analysis',
        priority: 5,
        status: 'completed',
        payload: { context: { email: 'test@example.com' } },
        createdAt: Date.now(),
        startedAt: Date.now() - 10000,
        completedAt: Date.now(),
        retries: 0,
        maxRetries: 3,
        timeout: 30000,
        result: { status: 'success', message: 'Test task completed' },
      },
      timestamp: Date.now(),
      message: 'This is a test notification',
    };

    console.log(`Testing ${channel} notification...`);

    switch (channel) {
      case 'email':
        if (this.emailSender) {
          await this.emailSender.send({
            to: 'test@example.com',
            subject: 'Test Notification',
            body: 'This is a test email notification.',
          });
          console.log('Email test sent');
        }
        break;

      case 'telegram':
        if (this.telegramSender) {
          await this.telegramSender.send({
            text: 'This is a test Telegram notification.',
          });
          console.log('Telegram test sent');
        }
        break;

      case 'console':
        this.logToConsole(testEvent, this.prepareTemplateVariables(testEvent));
        break;

      case 'webhook':
        console.log('Webhook notification test (configure webhookUrl in task context)');
        break;
    }
  }
}

/**
 * Email Sender Implementation
 */
class EmailSender {
  private config: any;

  constructor(config: any) {
    this.config = config;
  }

  async send(message: { to: string; subject: string; body: string }): Promise<void> {
    // Placeholder - implement based on provider
    console.log(`[Email] To: ${message.to}`);
    console.log(`[Email] Subject: ${message.subject}`);
    console.log(`[Email] Body: ${message.body.substring(0, 100)}...`);
  }
}

/**
 * Telegram Sender Implementation
 */
class TelegramSender {
  private botToken: string;
  private chatId: string;

  constructor(config: { botToken: string; chatId: string }) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
  }

  async send(message: { text: string }): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message.text,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram API returned ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Failed to send Telegram notification: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

export default NotificationService;

