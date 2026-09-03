/**
 * Connection Pooling System
 *
 * High-performance connection pooling for databases and external services
 */

import Emittery from 'emittery';

export interface PoolConfig {
  // Pool configuration
  min: number;
  max: number;
  acquireTimeout: number;
  idleTimeout: number;
  reapInterval: number;
  maxUses: number;

  // Health check
  healthCheck: {
    enabled: boolean;
    interval: number;
    timeout: number;
    query?: string;
  };

  // Performance
  metrics: {
    enabled: boolean;
    sampleRate: number;
    maxSamples: number;
  };
}

export interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
  totalAcquired: number;
  totalReleased: number;
  averageWaitTime: number;
  averageAcquireTime: number;
  maxWaitTime: number;
  minWaitTime: number;
  healthCheckFailures: number;
}

export interface Connection {
  id: string;
  createdAt: number;
  lastUsed: number;
  useCount: number;
  isHealthy: boolean;
  metadata?: any;
}

export interface PoolMetrics {
  connectionId: string;
  operation: 'acquire' | 'release' | 'create' | 'destroy';
  duration: number;
  timestamp: number;
}

export class ConnectionPool extends Emittery<Record<string, unknown>> {
  private config: PoolConfig;
  private connections = new Map<string, Connection>();
  private waitingQueue: Array<{
    resolve: (connection: Connection) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }> = [];
  private stats: PoolStats = {
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    waitingConnections: 0,
    totalAcquired: 0,
    totalReleased: 0,
    averageWaitTime: 0,
    averageAcquireTime: 0,
    maxWaitTime: 0,
    minWaitTime: Infinity,
    healthCheckFailures: 0,
  };

  private metrics: PoolMetrics[] = [];
  private isClosing = false;

  constructor(config: PoolConfig) {
    super();
    this.config = config;

    // Start reap interval
    if (config.reapInterval > 0) {
      setInterval(() => this.reapIdleConnections(), config.reapInterval);
    }

    // Start health check
    if (config.healthCheck.enabled) {
      setInterval(() => this.checkHealth(), config.healthCheck.interval);
    }

    // Start metrics collection
    if (config.metrics.enabled) {
      setInterval(() => this.collectMetrics(), 60000);
    }
  }

  /**
   * Acquire connection from pool
   */
  async acquire(): Promise<Connection> {
    if (this.isClosing) {
      throw new Error('Connection pool is closing');
    }

    const start = Date.now();
    const metrics = {
      operation: 'acquire' as const,
      timestamp: start,
    };

    try {
      // Try to get an idle connection first
      let connection = this.getIdleConnection();
      if (!connection) {
        // Create new connection if under max limit
        if (this.connections.size < this.config.max) {
          connection = await this.createConnection();
        } else {
          // Wait for available connection
          connection = await this.waitForConnection();
        }
      }

      // Mark as active
      connection.lastUsed = Date.now();
      connection.useCount++;
      this.stats.activeConnections++;
      this.stats.idleConnections--;

      // Update metrics
      const duration = Date.now() - start;
      this.updateAcquireMetrics(duration);

      // Log if slow acquisition
      if (duration > 1000) {
        this.emit('slow_acquire', { duration, activeConnections: this.stats.activeConnections });
      }

      this.emit('connection_acquired', { connection, duration });
      return connection;
    } catch (error) {
      this.emit('error', { operation: 'acquire', error });
      throw error;
    }
  }

  /**
   * Release connection back to pool
   */
  release(connection: Connection): void {
    const start = Date.now();

    try {
      // Check if connection is healthy
      if (!connection.isHealthy) {
        this.destroyConnection(connection);
        return;
      }

      // Check max uses
      if (connection.useCount >= this.config.maxUses) {
        this.destroyConnection(connection);
        return;
      }

      // Mark as idle
      connection.lastUsed = Date.now();
      this.stats.activeConnections--;
      this.stats.idleConnections++;

      // Update metrics
      const duration = Date.now() - start;
      this.updateReleaseMetrics(duration);

      // Check waiting queue
      if (this.waitingQueue.length > 0) {
        const waiter = this.waitingQueue.shift()!;
        setImmediate(() => waiter.resolve(connection));
        this.stats.waitingConnections--;
      }

      this.emit('connection_released', { connection, duration });
    } catch (error) {
      this.emit('error', { operation: 'release', connection, error });
    }
  }

  /**
   * Execute operation with connection
   */
  async use<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    const start = Date.now();

    try {
      const result = await fn(connection);
      return result;
    } finally {
      const duration = Date.now() - start;
      this.emit('operation_completed', { connection, duration });
      this.release(connection);
    }
  }

  /**
   * Close pool and all connections
   */
  async close(): Promise<void> {
    this.isClosing = true;

    // Reject waiting connections
    for (const waiter of this.waitingQueue) {
      waiter.reject(new Error('Connection pool is closing'));
    }
    this.waitingQueue = [];

    // Close all connections
    const closePromises = Array.from(this.connections.values()).map(conn =>
      this.destroyConnection(conn)
    );

    await Promise.all(closePromises);
    this.emit('pool_closed' as never);
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    // Calculate average times
    const totalAcquireTime = this.metrics
      .filter(m => m.operation === 'acquire')
      .reduce((sum, m) => sum + m.duration, 0);
    const acquireCount = this.metrics.filter(m => m.operation === 'acquire').length;

    if (acquireCount > 0) {
      this.stats.averageAcquireTime = totalAcquireTime / acquireCount;
    }

    // Calculate average wait time
    const totalWaitTime = this.waitingQueue.reduce((sum, w) => sum + (Date.now() - w.timestamp), 0);
    const waitCount = this.stats.waitingConnections;

    if (waitCount > 0) {
      this.stats.averageWaitTime = totalWaitTime / waitCount;
    }

    return { ...this.stats };
  }

  /**
   * Get all connections
   */
  getConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get pool size
   */
  size(): number {
    return this.connections.size;
  }

  /**
   * Check if pool is empty
   */
  isEmpty(): boolean {
    return this.connections.size === 0 && this.waitingQueue.length > 0;
  }

  /**
   * Resize pool
   */
  resize(newMin: number, newMax: number): void {
    this.config.min = newMin;
    this.config.max = newMax;

    // Remove connections if new max is lower
    if (this.connections.size > newMax) {
      const toRemove = this.connections.size - newMax;
      const connections = Array.from(this.connections.values());
      for (let i = 0; i < toRemove; i++) {
        const conn = connections[i];
        if (conn && conn.isHealthy) {
          this.destroyConnection(conn);
        }
      }
    }
  }

  /**
   * Get idle connection
   */
  private getIdleConnection(): Connection | null {
    for (const connection of this.connections.values()) {
      if (connection.isHealthy && this.stats.activeConnections < this.config.max) {
        return connection;
      }
    }
    return null;
  }

  /**
   * Wait for available connection
   */
  private async waitForConnection(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waitingQueue.findIndex(w => w.resolve === resolve);
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
          this.stats.waitingConnections--;
        }
        reject(new Error('Connection acquisition timeout'));
      }, this.config.acquireTimeout);

      this.waitingQueue.push({
        resolve: (conn: Connection) => {
          clearTimeout(timeout);
          resolve(conn);
        },
        reject,
        timestamp: Date.now(),
      });

      this.stats.waitingConnections++;

      // Check if timeout occurred while adding to queue
      if (this.stats.waitingConnections > 0 && this.waitingQueue[0]) {
        this.stats.maxWaitTime = Math.max(this.stats.maxWaitTime, Date.now() - this.waitingQueue[0].timestamp);
      }
    });
  }

  /**
   * Create new connection
   */
  private async createConnection(): Promise<Connection> {
    const connection: Connection = {
      id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 0,
      isHealthy: true,
    };

    this.connections.set(connection.id, connection);
    this.stats.totalConnections++;

    this.emit('connection_created', connection);
    return connection;
  }

  /**
   * Destroy connection
   */
  private async destroyConnection(connection: Connection): Promise<void> {
    try {
      if (this.connections.delete(connection.id)) {
        this.stats.totalConnections--;
        if (this.stats.activeConnections > 0) {
          this.stats.activeConnections--;
        }
        this.stats.totalReleased++;

        this.emit('connection_destroyed', connection);
      }
    } catch (error) {
      this.emit('error', { operation: 'destroy', connection, error });
    }
  }

  /**
   * Reap idle connections
   */
  private async reapIdleConnections(): Promise<void> {
    const now = Date.now();
    const idleConnections: Connection[] = [];

    for (const connection of this.connections.values()) {
      const idleTime = now - connection.lastUsed;
      if (idleTime > this.config.idleTimeout) {
        idleConnections.push(connection);
      }
    }

    // Remove idle connections if above min
    if (this.connections.size > this.config.min) {
      for (const connection of idleConnections) {
        await this.destroyConnection(connection);
      }
    }

    if (idleConnections.length > 0) {
      this.emit('idle_connections_reaped', { count: idleConnections.length });
    }
  }

  /**
   * Check connection health
   */
  private async checkHealth(): Promise<void> {
    const start = Date.now();

    try {
      const healthChecks = Array.from(this.connections.values()).map(async (conn) => {
        const isHealthy = await this.testConnection(conn);
        conn.isHealthy = isHealthy;
        return isHealthy;
      });

      const results = await Promise.all(healthChecks);
      const failed = results.filter(r => !r).length;

      if (failed > 0) {
        this.stats.healthCheckFailures += failed;
        this.emit('health_check_failed', { failed, total: this.connections.size });
      }
    } catch (error) {
      this.emit('error', { operation: 'health_check', error });
    }
  }

  /**
   * Test connection health
   */
  private async testConnection(connection: Connection): Promise<boolean> {
    try {
      // In real implementation, execute health check query
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Update acquire metrics
   */
  private updateAcquireMetrics(duration: number): void {
    this.metrics.push({
      connectionId: Date.now().toString(),
      operation: 'acquire',
      duration,
      timestamp: Date.now(),
    });

    this.stats.totalAcquired++;

    // Limit metric history
    if (this.metrics.length > this.config.metrics.maxSamples) {
      this.metrics = this.metrics.slice(-this.config.metrics.maxSamples);
    }
  }

  /**
   * Update release metrics
   */
  private updateReleaseMetrics(duration: number): void {
    this.metrics.push({
      connectionId: Date.now().toString(),
      operation: 'release',
      duration,
      timestamp: Date.now(),
    });

    this.stats.totalReleased++;

    // Limit metric history
    if (this.metrics.length > this.config.metrics.maxSamples) {
      this.metrics = this.metrics.slice(-this.config.metrics.maxSamples);
    }
  }

  /**
   * Collect metrics
   */
  private collectMetrics(): void {
    if (this.config.metrics.enabled) {
      // Sample metrics based on sample rate
      if (Math.random() < this.config.metrics.sampleRate) {
        this.emit('metrics_collected', this.getStats());
      }
    }
  }
}