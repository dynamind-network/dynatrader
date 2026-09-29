import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export class JsonRpcClient {
  private process: ChildProcess;
  private pending: Map<number, PendingRequest>;
  private eventHandlers: Map<string, Array<(params: unknown) => void>>;
  private nextId = 1;
  private rl: readline.Interface;
  private closed = false;
  private closeRequested = false;
  private transportFailure: Error | null = null;
  private stderrTail = '';

  constructor(command: string, args: string[], env?: NodeJS.ProcessEnv) {
    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.rl = readline.createInterface({ input: this.process.stdout! });
    this.setupStdio();
    this.process.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_096);
    });
    this.process.on('error', (error) => {
      this.failTransport(error);
    });
    this.process.on('exit', (code, signal) => {
      this.closed = true;
      if (this.closeRequested) return;

      const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      const diagnostic = this.stderrTail.trim();
      this.failTransport(
        new Error(
          `DynaTrader runtime exited before completing the request (${status})${diagnostic ? `: ${diagnostic}` : ''}`
        )
      );
    });
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (this.transportFailure) {
      throw this.transportFailure;
    }
    if (this.closed) {
      throw new Error('DynaTrader runtime transport is closed.');
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  on(event: string, handler: (params: unknown) => void) {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  off(event: string, handler: (params: unknown) => void) {
    const handlers = this.eventHandlers.get(event) || [];
    this.eventHandlers.set(
      event,
      handlers.filter((h) => h !== handler)
    );
  }

  close() {
    this.closeRequested = true;
    this.closed = true;
    this.rl.close();
    this.rejectPending(new Error('DynaTrader runtime transport was closed.'));
    this.process.kill();
  }

  private send(msg: unknown) {
    try {
      this.process.stdin!.write(JSON.stringify(msg) + '\n');
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private failTransport(error: Error): void {
    if (this.transportFailure) return;
    this.transportFailure = error;
    this.closed = true;
    this.rejectPending(error);
    const handlers = this.eventHandlers.get('transport.error') ?? [];
    handlers.forEach((handler) => handler(error));
  }

  private setupStdio() {
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;

        if ('id' in msg && msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(msg.error);
            } else {
              pending.resolve((msg as JsonRpcResponse).result);
            }
          }
        } else if ('method' in msg) {
          const handlers = this.eventHandlers.get(msg.method);
          if (handlers) {
            handlers.forEach((h) => h(msg.params));
          }
        }
      } catch {
        // Ignore parse errors
      }
    });
  }
}
