/**
 * StdioTransport for MCP (Model Context Protocol)
 *
 * Spawns a child process and communicates via stdin/stdout
 * using JSON-RPC 2.0 messages (newline-delimited).
 *
 * Features:
 * - envFilter security: only pass specified env vars from parent
 * - Configurable timeout (default 30s)
 * - Auto-reconnect on process exit (configurable maxRetries)
 * - Stderr forwarding for debugging
 * - Notification handler support
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  MCPServerConfig,
  MCPJsonRpcRequest,
  MCPJsonRpcResponse,
  MCPTransport,
} from "./mcp-types";

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: MCPJsonRpcResponse) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// StdioTransport
// ---------------------------------------------------------------------------

export class StdioTransport implements MCPTransport {
  private process_: ChildProcess | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private buffer: string = "";
  private messageId: number = 0;
  private connected_: boolean = false;
  private notificationHandlers: Array<
    (notification: { method: string; params?: unknown }) => void
  > = [];
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disconnectRequested: boolean = false;

  constructor(
    private config: MCPServerConfig,
    private options: {
      timeoutMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
    } = {},
  ) {}

  /**
   * Spawn the child process and set up I/O pipes.
   */
  async connect(): Promise<void> {
    const cmd = this.config.command;
    if (!cmd) {
      throw new Error("Stdio transport requires a 'command' in server config");
    }

    const args = this.config.args ?? [];
    this.disconnectRequested = false;

    return new Promise<void>((resolve, reject) => {
      try {
        // Build environment: apply envFilter for security
        const env = this.buildEnvironment();

        this.process_ = spawn(cmd, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });

        this.process_.on("error", (err) => {
          this.connected_ = false;
          this.rejectAllPending(err);
          reject(err);
        });

        this.process_.on("close", (code) => {
          this.connected_ = false;
          const err = new Error(
            `Process '${this.config.name}' exited with code ${code ?? "null"}`,
          );
          this.rejectAllPending(err);

          // Auto-reconnect unless disconnect was requested
          if (!this.disconnectRequested) {
            this.scheduleReconnect();
          }
        });

        this.process_.stdout?.on("data", (data: Buffer) => {
          this.buffer += data.toString();
          this.processBuffer();
        });

        this.process_.stderr?.on("data", (data: Buffer) => {
          // Forward stderr for debugging
          console.debug(
            `[StdioTransport:${this.config.name}]`,
            data.toString(),
          );
        });

        this.connected_ = true;
        this.reconnectAttempts = 0;
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Kill the child process and clean up.
   */
  async disconnect(): Promise<void> {
    this.disconnectRequested = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.process_ && !this.process_.killed) {
      this.process_.kill();
    }
    this.process_ = null;
    this.connected_ = false;
    this.rejectAllPending(new Error("Transport disconnected"));
  }

  /**
   * Send a JSON-RPC request and return the response.
   */
  async send(request: MCPJsonRpcRequest): Promise<MCPJsonRpcResponse> {
    if (!this.process_ || !this.process_.stdin?.writable) {
      throw new Error("Transport is not connected");
    }

    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const id =
      typeof request.id === "number"
        ? request.id
        : ++this.messageId;

    return new Promise<MCPJsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC call timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const payload =
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: request.method,
          params: request.params,
        }) + "\n";

      try {
        this.process_!.stdin!.write(payload, "utf-8");
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /** Check if the transport is currently connected */
  isConnected(): boolean {
    return (
      this.connected_ &&
      this.process_ !== null &&
      !this.process_.killed
    );
  }

  /**
   * Register a handler for notifications from the server.
   * Notifications are JSON-RPC messages without an 'id' field.
   */
  onNotification(
    handler: (notification: { method: string; params?: unknown }) => void,
  ): void {
    this.notificationHandlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build the environment for the child process.
   * If envFilter is specified, only pass those env vars from the parent.
   * If env overrides are specified, they take precedence.
   */
  private buildEnvironment(): NodeJS.ProcessEnv {
    const envFilter = this.config.envFilter;
    const envOverrides = this.config.env;

    let baseEnv: NodeJS.ProcessEnv;

    if (envFilter && envFilter.length > 0) {
      // Security: only pass specified env vars
      baseEnv = {};
      for (const key of envFilter) {
        if (process.env[key] !== undefined) {
          baseEnv[key] = process.env[key];
        }
      }
    } else {
      // Pass all parent env vars (default behavior)
      baseEnv = { ...process.env };
    }

    // Apply env overrides
    if (envOverrides) {
      for (const [key, value] of Object.entries(envOverrides)) {
        baseEnv[key] = value;
      }
    }

    return baseEnv;
  }

  /**
   * Schedule an auto-reconnect attempt.
   */
  private scheduleReconnect(): void {
    const maxRetries = this.options.maxRetries ?? 3;
    const retryDelayMs = this.options.retryDelayMs ?? 2000;

    if (this.reconnectAttempts >= maxRetries) {
      console.error(
        `[StdioTransport:${this.config.name}] Max reconnect attempts (${maxRetries}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = retryDelayMs * this.reconnectAttempts; // Linear backoff

    console.debug(
      `[StdioTransport:${this.config.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxRetries})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        console.debug(
          `[StdioTransport:${this.config.name}] Reconnected successfully`,
        );
      } catch (err) {
        console.error(
          `[StdioTransport:${this.config.name}] Reconnect failed:`,
          err,
        );
      }
    }, delay);
  }

  /**
   * Parse buffered stdout data, splitting by newlines and
   * matching JSON-RPC responses to pending requests.
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep trailing incomplete line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          parsed.jsonrpc === "2.0"
        ) {
          if (typeof parsed.id === "number") {
            // This is a response to a pending request
            const pending = this.pendingRequests.get(parsed.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingRequests.delete(parsed.id);
              pending.resolve(parsed as MCPJsonRpcResponse);
            }
          } else if (parsed.id === undefined || parsed.id === null) {
            // This is a notification (no id)
            const notification = {
              method: (parsed as { method?: string }).method ?? "",
              params: (parsed as { params?: unknown }).params,
            };
            for (const handler of this.notificationHandlers) {
              try {
                handler(notification);
              } catch {
                // Handler errors are silently caught
              }
            }
          }
        }
      } catch {
        // Non-JSON output lines are ignored (e.g., startup banners)
      }
    }
  }

  /** Reject all pending requests with a given error */
  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}