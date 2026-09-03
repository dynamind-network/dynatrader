/**
 * Performance Monitoring and Metrics Collection
 *
 * Real-time performance monitoring with metrics collection and alerting
 */

import Emittery from 'emittery';

export interface Metrics {
  // Application metrics
  app: {
    uptime: number;
    memoryUsage: {
      used: number;
      total: number;
      percentage: number;
    };
    cpuUsage: number;
    gcStats?: {
      total: number;
      time: number;
      pause: number;
    };
  };

  // Network metrics
  network: {
    requests: {
      total: number;
      perSecond: number;
      averageTime: number;
      minTime: number;
      maxTime: number;
    };
    errors: {
      total: number;
      rate: number;
      byType: Record<string, number>;
    };
    bandwidth: {
      in: number;
      out: number;
    };
  };

  // Database metrics
  database: {
    queries: {
      total: number;
      perSecond: number;
      slow: number;
      averageTime: number;
    };
    connections: {
      active: number;
      idle: number;
      total: number;
      waiting: number;
    };
    transactions: {
      committed: number;
      rolledBack: number;
      duration: {
        average: number;
        max: number;
      };
    };
  };

  // Trading metrics
  trading: {
    orders: {
      total: number;
      perSecond: number;
      success: number;
      failed: number;
      latency: {
        average: number;
        max: number;
      };
    };
    positions: {
      open: number;
      closed: number;
      totalProfit: number;
      winRate: number;
    };
    latency: {
      exchange: number;
      processing: number;
      total: number;
    };
  };

  // Cache metrics
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    memoryUsage: number;
  };

  // Error tracking
  errors: {
    total: number;
    byType: Record<string, number>;
    byModule: Record<string, number>;
    recent: Array<{
      type: string;
      module: string;
      message: string;
      timestamp: number;
      stack?: string;
    }>;
  };

  // Custom metrics
  custom: Record<string, any>;
}

export interface AlertRule {
  id: string;
  name: string;
  condition: (metrics: Metrics) => boolean;
  threshold: number;
  window: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
  enabled: boolean;
  actions: {
    notification: boolean;
    log: boolean;
    escalate: boolean;
  };
}

export interface Alert {
  id: string;
  ruleId: string;
  name: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  resolved: boolean;
  resolvedAt?: number;
  metadata?: any;
}

export class PerformanceMonitor extends Emittery<Record<string, unknown>> {
  private metrics!: Metrics;
  private alerts = new Map<string, Alert>();
  private rules: AlertRule[] = [];
  private history: Metrics[] = [];
  private collectionInterval: NodeJS.Timeout | null = null;
  private alertInterval: NodeJS.Timeout | null = null;

  constructor(
    public collectionIntervalMs = 10000,
    public alertIntervalMs = 5000,
    public maxHistorySize = 1000
  ) {
    super();
    this.initializeMetrics();
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.collectionInterval) return;

    // Start metrics collection
    this.collectionInterval = setInterval(() => {
      this.collectMetrics();
    }, this.collectionIntervalMs);

    // Start alert checking
    this.alertInterval = setInterval(() => {
      this.checkAlerts();
    }, this.alertIntervalMs);

    this.emit('monitoring_started' as never);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }

    if (this.alertInterval) {
      clearInterval(this.alertInterval);
      this.alertInterval = null;
    }

    this.emit('monitoring_stopped' as never);
  }

  /**
   * Get current metrics
   */
  getMetrics(): Metrics {
    return { ...this.metrics };
  }

  /**
   * Get metrics history
   */
  getHistory(limit?: number): Metrics[] {
    const history = [...this.history];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Get alerts
   */
  getAlerts(severity?: Alert['severity']): Alert[] {
    const alerts = Array.from(this.alerts.values());
    return severity ? alerts.filter(a => a.severity === severity) : alerts;
  }

  /**
   * Get unresolved alerts
   */
  getUnresolvedAlerts(): Alert[] {
    return Array.from(this.alerts.values()).filter(a => !a.resolved);
  }

  /**
   * Add alert rule
   */
  addRule(rule: AlertRule): void {
    this.rules.push(rule);
    this.emit('rule_added', rule);
  }

  /**
   * Remove alert rule
   */
  removeRule(ruleId: string): void {
    this.rules = this.rules.filter(r => r.id !== ruleId);
    this.emit('rule_removed', { ruleId });
  }

  /**
   * Enable alert rule
   */
  enableRule(ruleId: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = true;
      this.emit('rule_enabled', rule);
    }
  }

  /**
   * Disable alert rule
   */
  disableRule(ruleId: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = false;
      this.emit('rule_disabled', rule);
    }
  }

  /**
   * Record custom metric
   */
  recordMetric(name: string, value: any): void {
    this.metrics.custom[name] = value;
    this.emit('metric_recorded', { name, value });
  }

  /**
   * Record error
   */
  recordError(type: string, module: string, message: string, stack?: string): void {
    this.metrics.errors.total++;
    this.metrics.errors.byType[type] = (this.metrics.errors.byType[type] || 0) + 1;
    this.metrics.errors.byModule[module] = (this.metrics.errors.byModule[module] || 0) + 1;

    this.metrics.errors.recent.unshift({
      type,
      module,
      message,
      timestamp: Date.now(),
      stack,
    });

    // Keep recent errors limited
    if (this.metrics.errors.recent.length > 100) {
      this.metrics.errors.recent = this.metrics.errors.recent.slice(0, 100);
    }

    this.emit('error_recorded', { type, module, message });
  }

  /**
   * Initialize metrics
   */
  private initializeMetrics(): void {
    this.metrics = {
      app: {
        uptime: process.uptime(),
        memoryUsage: {
          used: 0,
          total: 0,
          percentage: 0,
        },
        cpuUsage: 0,
      },
      network: {
        requests: {
          total: 0,
          perSecond: 0,
          averageTime: 0,
          minTime: 0,
          maxTime: 0,
        },
        errors: {
          total: 0,
          rate: 0,
          byType: {},
        },
        bandwidth: {
          in: 0,
          out: 0,
        },
      },
      database: {
        queries: {
          total: 0,
          perSecond: 0,
          slow: 0,
          averageTime: 0,
        },
        connections: {
          active: 0,
          idle: 0,
          total: 0,
          waiting: 0,
        },
        transactions: {
          committed: 0,
          rolledBack: 0,
          duration: {
            average: 0,
            max: 0,
          },
        },
      },
      trading: {
        orders: {
          total: 0,
          perSecond: 0,
          success: 0,
          failed: 0,
          latency: {
            average: 0,
            max: 0,
          },
        },
        positions: {
          open: 0,
          closed: 0,
          totalProfit: 0,
          winRate: 0,
        },
        latency: {
          exchange: 0,
          processing: 0,
          total: 0,
        },
      },
      cache: {
        hits: 0,
        misses: 0,
        hitRate: 0,
        size: 0,
        memoryUsage: 0,
      },
      errors: {
        total: 0,
        byType: {},
        byModule: {},
        recent: [],
      },
      custom: {},
    };
  }

  /**
   * Collect metrics
   */
  private collectMetrics(): void {
    try {
      // Update metrics
      this.updateAppMetrics();
      this.updateNetworkMetrics();
      this.updateDatabaseMetrics();
      this.updateTradingMetrics();
      this.updateCacheMetrics();

      // Add to history
      this.history.push({ ...this.metrics });
      if (this.history.length > this.maxHistorySize) {
        this.history.shift();
      }

      this.emit('metrics_collected', this.metrics);
    } catch (error) {
      this.emit('error', { operation: 'collectMetrics', error });
    }
  }

  /**
   * Update application metrics
   */
  private updateAppMetrics(): void {
    const memUsage = process.memoryUsage();
    const startUsage = process.cpuUsage();

    this.metrics.app.memoryUsage = {
      used: memUsage.heapUsed,
      total: memUsage.heapTotal,
      percentage: (memUsage.heapUsed / memUsage.heapTotal) * 100,
    };

    this.metrics.app.cpuUsage = process.cpuUsage(startUsage).user / 1000000; // Convert to seconds
  }

  /**
   * Update network metrics
   */
  private updateNetworkMetrics(): void {
    // In real implementation, track actual network requests
    // For now, just update per-second calculations
    if (this.history.length > 0) {
      const prev = this.history[this.history.length - 1];
      if (!prev) return;
      const timeDiff = (this.metrics.app.uptime - prev.app.uptime) * 1000;

      this.metrics.network.requests.perSecond = timeDiff > 0 ?
        (this.metrics.network.requests.total - prev.network.requests.total) / (timeDiff / 1000) : 0;
    }
  }

  /**
   * Update database metrics
   */
  private updateDatabaseMetrics(): void {
    // In real implementation, track actual database queries
    if (this.history.length > 0) {
      const prev = this.history[this.history.length - 1];
      if (!prev) return;
      const timeDiff = (this.metrics.app.uptime - prev.app.uptime) * 1000;

      this.metrics.database.queries.perSecond = timeDiff > 0 ?
        (this.metrics.database.queries.total - prev.database.queries.total) / (timeDiff / 1000) : 0;
    }
  }

  /**
   * Update trading metrics
   */
  private updateTradingMetrics(): void {
    // Calculate win rate
    const totalTrades = this.metrics.trading.positions.open + this.metrics.trading.positions.closed;
    if (totalTrades > 0) {
      this.metrics.trading.positions.winRate = (this.metrics.trading.positions.closed / totalTrades) * 100;
    }
  }

  /**
   * Update cache metrics
   */
  private updateCacheMetrics(): void {
    const total = this.metrics.cache.hits + this.metrics.cache.misses;
    if (total > 0) {
      this.metrics.cache.hitRate = (this.metrics.cache.hits / total) * 100;
    }
  }

  /**
   * Check alert rules
   */
  private checkAlerts(): void {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      try {
        const value = rule.condition(this.metrics);
        if (value && !this.alerts.has(rule.id)) {
          // Trigger alert
          const alert: Alert = {
            id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ruleId: rule.id,
            name: rule.name,
            severity: rule.severity,
            message: `Alert triggered: ${rule.name}`,
            value: value ? 1 : 0,
            threshold: rule.threshold,
            timestamp: Date.now(),
            resolved: false,
            metadata: { condition: rule.condition.toString() },
          };

          this.alerts.set(alert.id, alert);

          // Execute actions
          if (rule.actions.notification) {
            this.emit('alert_triggered', alert);
          }

          if (rule.actions.log) {
            console.log(`[${alert.severity.toUpperCase()}] ${alert.message}`);
          }

          if (rule.actions.escalate) {
            this.emit('alert_escalated', alert);
          }
        } else if (!value && this.alerts.has(rule.id)) {
          // Resolve alert
          const alert = this.alerts.get(rule.id)!;
          alert.resolved = true;
          alert.resolvedAt = Date.now();

          this.emit('alert_resolved', alert);
        }
      } catch (error) {
        this.emit('error', { operation: 'checkAlerts', rule, error });
      }
    }
  }

  /**
   * Export metrics
   */
  exportMetrics(format: 'json' | 'prometheus' = 'json'): string {
    if (format === 'prometheus') {
      return this.exportPrometheus();
    }
    return JSON.stringify(this.metrics, null, 2);
  }

  /**
   * Export in Prometheus format
   */
  private exportPrometheus(): string {
    let output = '';

    // App metrics
    output += `# HELP dyna_trader_app_uptime_seconds Application uptime in seconds\n`;
    output += `# TYPE dyna_trader_app_uptime_seconds gauge\n`;
    output += `dyna_trader_app_uptime_seconds ${this.metrics.app.uptime}\n`;

    output += `# HELP dyna_trader_app_memory_usage_bytes Memory usage in bytes\n`;
    output += `# TYPE dyna_trader_app_memory_usage_bytes gauge\n`;
    output += `dyna_trader_app_memory_usage_bytes{type="used"} ${this.metrics.app.memoryUsage.used}\n`;
    output += `dyna_trader_app_memory_usage_bytes{type="total"} ${this.metrics.app.memoryUsage.total}\n`;

    output += `# HELP dyna_trader_app_cpu_usage_seconds CPU usage in seconds\n`;
    output += `# TYPE dyna_trader_app_cpu_usage_seconds gauge\n`;
    output += `dyna_trader_app_cpu_usage_seconds ${this.metrics.app.cpuUsage}\n`;

    // Network metrics
    output += `# HELP dyna_trader_network_requests_total Total network requests\n`;
    output += `# TYPE dyna_trader_network_requests_total counter\n`;
    output += `dyna_trader_network_requests_total ${this.metrics.network.requests.total}\n`;

    output += `# HELP dyna_trader_network_requests_per_second Network requests per second\n`;
    output += `# TYPE dyna_trader_network_requests_per_second gauge\n`;
    output += `dyna_trader_network_requests_per_second ${this.metrics.network.requests.perSecond}\n`;

    // Database metrics
    output += `# HELP dyna_trader_database_queries_total Total database queries\n`;
    output += `# TYPE dyna_trader_database_queries_total counter\n`;
    output += `dyna_trader_database_queries_total ${this.metrics.database.queries.total}\n`;

    output += `# HELP dyna_trader_database_queries_per_second Database queries per second\n`;
    output += `# TYPE dyna_trader_database_queries_per_second gauge\n`;
    output += `dyna_trader_database_queries_per_second ${this.metrics.database.queries.perSecond}\n`;

    return output;
  }
}