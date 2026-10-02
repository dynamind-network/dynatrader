// Import WebSocket dynamically to support both Node.js 20+ and older versions
const getWebSocket = async () => {
  try {
    // Try global WebSocket first (Node.js 20+)
    if (global.WebSocket) {
      return global.WebSocket;
    }
    // Fallback to ws library
    const ws = await import('ws');
    return ws.default;
  } catch {
    throw new Error('WebSocket library not available');
  }
};
import {
  Exchange,
  Symbol,
  MessageType,
  ConnectionState,
  WebSocketMessage,
  ExchangeAdapter,
} from './types.js';
import { parseJson } from '../../utils/json.js';
import { resolveExchangeWebSocketUrl } from '../../config/exchange-urls.js';

export abstract class BaseAdapter implements ExchangeAdapter {
  abstract exchange: Exchange;

  protected ws: any = null;
  protected state: ConnectionState = 'disconnected';
  protected subscribedSymbols: Symbol[] = [];
  protected subscribedStreams: MessageType[] = [];

  protected messageCallback: ((message: WebSocketMessage) => void) | null = null;
  protected stateCallback: ((state: ConnectionState) => void) | null = null;
  protected errorCallback: ((error: Error) => void) | null = null;

  protected reconnectAttempts = 0;
  protected maxReconnectAttempts = 10;
  protected reconnectDelay = 1000;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  protected pingInterval: NodeJS.Timeout | null = null;
  protected pingIntervalMs = 30000;

  protected pendingConnectResolve: (() => void) | null = null;
  protected pendingConnectReject: ((err: Error) => void) | null = null;
  protected connectionTimeout: NodeJS.Timeout | null = null;

  protected normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    if (error && typeof error === 'object' && 'error' in error && error.error instanceof Error) {
      return error.error;
    }

    if (
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return new Error(error.message);
    }

    if (typeof error === 'string' && error.length > 0) {
      return new Error(error);
    }

    return new Error(`Unknown ${this.exchange} WebSocket error`);
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return new Promise((resolve) => {
        const checkConnected = setInterval(() => {
          if (this.state === 'connected') {
            clearInterval(checkConnected);
            resolve();
          } else if (this.state === 'disconnected' || this.state === 'error') {
            clearInterval(checkConnected);
            resolve();
          }
        }, 100);
        setTimeout(() => {
          clearInterval(checkConnected);
          resolve();
        }, 5000);
      });
    }

    if (this.pendingConnectReject) {
      this.pendingConnectReject(new Error('Connection superseded by new connect() call'));
      this.pendingConnectReject = null;
      this.pendingConnectResolve = null;
    }

    const WebSocket = await getWebSocket();

    return new Promise((resolve, reject) => {
      this.pendingConnectResolve = resolve;
      this.pendingConnectReject = reject;

      const url = resolveExchangeWebSocketUrl(this.exchange, this.getWebSocketUrl());
      if (!url) {
        reject(new Error(`No WebSocket URL for ${this.exchange}`));
        return;
      }

      this.setState('connecting');
      this.ws = new WebSocket(url);

      const setupEventListeners = (ws: any) => {
        if (typeof ws.addEventListener === 'function') {
          ws.addEventListener('open', () => {
            this.setState('connected');
            this.reconnectAttempts = 0;
            this.startPing();
            this.onConnect();
            this.pendingConnectResolve?.();
            this.pendingConnectResolve = null;
            this.pendingConnectReject = null;
          });

          ws.addEventListener('message', (data: any) => {
            try {
              const parsed = parseJson(data.data.toString());
              if (parsed) {
                this.handleRawMessage(parsed);
              }
            } catch (err) {
              // Binary or unparseable data
            }
          });

          ws.addEventListener('close', (event: any) => {
            this.stopPing();
            if (this.state !== 'disconnected') {
              this.scheduleReconnect();
            }
          });

          ws.addEventListener('error', (error: any) => {
            const normalizedError = this.normalizeError(error);
            if (this.errorCallback) {
              this.errorCallback(normalizedError);
            }
            if (this.state === 'connecting') {
              this.pendingConnectReject?.(normalizedError);
            }
          });
        } else {
          ws.on('open', () => {
            this.setState('connected');
            this.reconnectAttempts = 0;
            this.startPing();
            this.onConnect();
            this.pendingConnectResolve?.();
            this.pendingConnectResolve = null;
            this.pendingConnectReject = null;
          });

          ws.on('message', (data: any) => {
            try {
              const parsed = parseJson(data.toString());
              if (parsed) {
                this.handleRawMessage(parsed);
              }
            } catch (err) {
              // Binary or unparseable data
            }
          });

          ws.on('close', (code: any, reason: any) => {
            this.stopPing();
            if (this.state !== 'disconnected') {
              this.scheduleReconnect();
            }
          });

          ws.on('error', (error: any) => {
            const normalizedError = this.normalizeError(error);
            if (this.errorCallback) {
              this.errorCallback(normalizedError);
            }
            if (this.state === 'connecting') {
              this.pendingConnectReject?.(normalizedError);
            }
          });
        }
      };

      setupEventListeners(this.ws);

      this.connectionTimeout = setTimeout(() => {
        if (this.state === 'connecting') {
          this.pendingConnectReject?.(new Error(`Connection timeout for ${this.exchange}`));
          this.ws?.close();
        }
      }, 10000);
    });
  }

  disconnect(): void {
    this.setState('disconnected');
    this.stopPing();
    this.clearReconnectTimer();
    this.clearConnectionTimeout();
    if (this.pendingConnectReject) {
      this.pendingConnectReject(new Error('Disconnected'));
      this.pendingConnectReject = null;
      this.pendingConnectResolve = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(symbols: Symbol[], streams: MessageType[]): void {
    this.subscribedSymbols = [...new Set([...this.subscribedSymbols, ...symbols])];
    this.subscribedStreams = [...new Set([...this.subscribedStreams, ...streams])];

    if (this.state === 'connected') {
      this.sendSubscription(symbols, streams, true);
    }
  }

  unsubscribe(symbols: Symbol[], streams: MessageType[]): void {
    this.subscribedSymbols = this.subscribedSymbols.filter((s) => !symbols.includes(s));

    if (this.state === 'connected') {
      this.sendSubscription(symbols, streams, false);
    }
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  onMessage(callback: (message: WebSocketMessage) => void): void {
    this.messageCallback = callback;
  }

  onStateChange(callback: (state: ConnectionState) => void): void {
    this.stateCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  // Protected methods to be implemented by exchange-specific adapters
  protected abstract getWebSocketUrl(): string;
  protected abstract handleRawMessage(data: any): void;
  protected abstract sendSubscription(
    symbols: Symbol[],
    streams: MessageType[],
    subscribe: boolean
  ): void;

  // Optional hooks
  protected onConnect(): void {}
  protected getPingMessage(): any {
    return { op: 'ping' };
  }

  protected setState(state: ConnectionState): void {
    this.state = state;
    if (this.stateCallback) {
      this.stateCallback(state);
    }
  }

  protected emitMessage(message: WebSocketMessage): void {
    if (this.messageCallback) {
      this.messageCallback(message);
    }
  }

  protected send(data: any): void {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 'OPEN')) {
      // Support both formats
      this.ws.send(JSON.stringify(data));
    }
  }

  protected startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 'OPEN')) {
        // Support both formats
        const pingMsg = this.getPingMessage();
        if (pingMsg) {
          this.send(pingMsg);
        }
      }
    }, this.pingIntervalMs);
  }

  protected stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  protected scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setState('error');
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        // Re-subscribe after reconnect
        if (this.subscribedSymbols.length > 0) {
          this.sendSubscription(this.subscribedSymbols, this.subscribedStreams, true);
        }
      } catch (error) {
        if (this.errorCallback) {
          this.errorCallback(this.normalizeError(error));
        }
        this.scheduleReconnect();
      }
    }, delay);
  }

  protected clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  protected clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }
}

