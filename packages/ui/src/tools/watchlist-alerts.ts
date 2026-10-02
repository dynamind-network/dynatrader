import { BaseTool } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import Conf from 'conf';

// Persistent storage for watchlist
const watchlistConfig = new Conf<{ watchlist: string[] }>({
  projectName: 'dynamind-terminal',
  defaults: { watchlist: [] },
});

// Persistent storage for alerts
interface Alert {
  id: string;
  coin: string;
  condition: 'above' | 'below';
  targetPrice: number;
  triggered: boolean;
  createdAt: string;
}

const alertConfig = new Conf<{ alerts: Alert[] }>({
  projectName: 'dynamind-terminal',
  defaults: { alerts: [] },
});

/**
 * Manage watchlist - add/remove/view symbols
 */
export class WatchlistTool extends BaseTool {
  name = 'watchlist';
  description = `Manage the saved watchlist. Use this first when the user asks to add, remove, clear, or view watchlist symbols. Actions: add, remove, view, clear.`;
  isDestructive = false;
  mutatesExternalState = true;

  inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: add, remove, view, clear',
        enum: ['add', 'remove', 'view', 'clear'],
      },
      symbol: {
        type: 'string',
        description: 'Symbol to add or remove (use any configured asset symbol)',
      },
    },
    required: ['action'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const action = input.action as string;
    const symbol = (input.symbol as string)?.toUpperCase();

    switch (action) {
      case 'add':
        return this.addToWatchlist(symbol);
      case 'remove':
        return this.removeFromWatchlist(symbol);
      case 'view':
        return this.viewWatchlist();
      case 'clear':
        return this.clearWatchlist();
      default:
        return this.error(`Unknown action: ${action}`);
    }
  }

  private addToWatchlist(symbol: string): ToolResult {
    if (!symbol) {
      return this.error('Symbol is required for add action');
    }

    const watchlist = watchlistConfig.get('watchlist') || [];

    if (watchlist.includes(symbol)) {
      return this.success(`${symbol} is already in your watchlist`);
    }

    watchlist.push(symbol);
    watchlistConfig.set('watchlist', watchlist);

    return this.success(`Added ${symbol} to watchlist. Current watchlist: ${watchlist.join(', ')}`);
  }

  private removeFromWatchlist(symbol: string): ToolResult {
    if (!symbol) {
      return this.error('Symbol is required for remove action');
    }

    const watchlist = watchlistConfig.get('watchlist') || [];
    const index = watchlist.indexOf(symbol);

    if (index === -1) {
      return this.success(`${symbol} is not in your watchlist`);
    }

    watchlist.splice(index, 1);
    watchlistConfig.set('watchlist', watchlist);

    return this.success(
      `Removed ${symbol} from watchlist. Current watchlist: ${watchlist.join(', ') || '(empty)'}`
    );
  }

  private viewWatchlist(): ToolResult {
    const watchlist = watchlistConfig.get('watchlist') || [];

    if (watchlist.length === 0) {
      return this.success(
        'Your watchlist is empty. Use "add <symbol> to watchlist" to add assets.'
      );
    }

    return this.success(`Your watchlist (${watchlist.length} items):\n${watchlist.join(', ')}`);
  }

  private clearWatchlist(): ToolResult {
    watchlistConfig.set('watchlist', []);
    return this.success('Watchlist cleared');
  }
}

/**
 * Manage price alerts - create/delete/view alerts
 */
export class AlertsTool extends BaseTool {
  name = 'alerts';
  description = `Manage price alerts. Use this first when the user asks to create, delete, inspect, or clear alerts for symbols. Actions: create, delete, view, clear.`;
  isDestructive = false;
  mutatesExternalState = true;

  inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: create, delete, view, clear',
        enum: ['create', 'delete', 'view', 'clear'],
      },
      symbol: {
        type: 'string',
        description: 'Symbol for the alert (use any configured asset symbol)',
      },
      condition: {
        type: 'string',
        description: 'Condition: above or below',
        enum: ['above', 'below'],
      },
      price: {
        type: 'number',
        description: 'Target price for the alert',
      },
      alert_id: {
        type: 'string',
        description: 'Alert ID for delete action',
      },
    },
    required: ['action'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const action = input.action as string;

    switch (action) {
      case 'create':
        return this.createAlert(input);
      case 'delete':
        return this.deleteAlert(input.alert_id as string);
      case 'view':
        return this.viewAlerts();
      case 'clear':
        return this.clearTriggeredAlerts();
      default:
        return this.error(`Unknown action: ${action}`);
    }
  }

  private createAlert(input: Record<string, unknown>): ToolResult {
    const symbol = (input.symbol as string)?.toUpperCase();
    const condition = input.condition as 'above' | 'below';
    const price = input.price as number;

    if (!symbol || !condition || !price) {
      return this.error('Required: symbol, condition (above/below), and price');
    }

    const alerts = alertConfig.get('alerts') || [];

    const newAlert: Alert = {
      id: Date.now().toString(),
      coin: symbol,
      condition,
      targetPrice: price,
      triggered: false,
      createdAt: new Date().toISOString(),
    };

    alerts.push(newAlert);
    alertConfig.set('alerts', alerts);

    return this.success(
      `Alert created: ${symbol} ${condition} $${price.toLocaleString()}\n` +
        `Alert ID: ${newAlert.id}\n` +
        `View alerts with Alt+A or check the Alerts screen (F5)`
    );
  }

  private deleteAlert(alertId: string): ToolResult {
    if (!alertId) {
      return this.error('Alert ID is required for delete action');
    }

    const alerts = alertConfig.get('alerts') || [];
    const index = alerts.findIndex((a: Alert) => a.id === alertId);

    if (index === -1) {
      return this.error(`Alert with ID ${alertId} not found`);
    }

    const removed = alerts.splice(index, 1)[0];
    alertConfig.set('alerts', alerts);

    return this.success(
      `Deleted alert: ${removed.coin} ${removed.condition} $${removed.targetPrice}`
    );
  }

  private viewAlerts(): ToolResult {
    const alerts = alertConfig.get('alerts') || [];

    if (alerts.length === 0) {
      return this.success(
        'No alerts set. Create one with: "alert me when <symbol> goes above <price>" using a workspace asset symbol.'
      );
    }

    const activeAlerts = alerts.filter((a: Alert) => !a.triggered);
    const triggeredAlerts = alerts.filter((a: Alert) => a.triggered);

    let result = `Price Alerts (${alerts.length} total)\n\n`;

    if (activeAlerts.length > 0) {
      result += `Active (${activeAlerts.length}):\n`;
      for (const alert of activeAlerts) {
        result += `  - ${alert.coin} ${alert.condition} $${alert.targetPrice.toLocaleString()} (ID: ${alert.id})\n`;
      }
    }

    if (triggeredAlerts.length > 0) {
      result += `\nTriggered (${triggeredAlerts.length}):\n`;
      for (const alert of triggeredAlerts) {
        result += `  - ${alert.coin} ${alert.condition} $${alert.targetPrice.toLocaleString()} [TRIGGERED]\n`;
      }
    }

    return this.success(result);
  }

  private clearTriggeredAlerts(): ToolResult {
    const alerts = alertConfig.get('alerts') || [];
    const active = alerts.filter((a: Alert) => !a.triggered);
    const removed = alerts.length - active.length;

    alertConfig.set('alerts', active);

    return this.success(
      `Cleared ${removed} triggered alert(s). ${active.length} active alert(s) remaining.`
    );
  }
}

