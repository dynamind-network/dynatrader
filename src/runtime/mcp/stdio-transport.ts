/**
 * StdioTransport for MCP (Model Context Protocol)
 *
 * Manages a child process for stdio-based MCP servers.
 * Communicates via stdin/stdout using JSON-RPC 2.0 messages.
 */

import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Types (local, avoid circular dep with mcp-runtime)
// ---------------------------------------------------------------------------

interface StdioServerConfig {
  name: string;
  transport: "stdio";
  command?: string;
  args?: string[];
  enabled?: boolean;
}

/** A pending JSON-RPC request awaiting a response */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// StdioTransport
// ---------------------------------------------------------------------------

export class StdioTransport {
  private process_: ChildProcess | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private buffer: string = "";
  private messageId: number = 0;
  private connected_: boolean = false;

  constructor(private config: StdioServerConfig) {}

  /**
   * Spawn the child process and set up I/O pipes.
   * Resolves once the process is spawned successfully.
   */
  async connect(): Promise<void> {
    const cmd = this.config.command;
    if (!cmd) {
      throw new Error("Stdio transport requires a 'command' in server config");
    }

    const args = this.config.args ?? [];

    return new Promise<void>((resolve, reject) => {
      try {
        this.process_ = spawn(cmd, args, {
          stdio: ["pipe", "pipe", "pipe"],
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
        });

        this.process_.stdout?.on("data", (data: Buffer) => {
          this.buffer += data.toString();
          this.processBuffer();
        });

        this.process_.stderr?.on("data", (data: Buffer) => {
          // Forward stderr for debugging
          console.debug(`[StdioTransport:${this.config.name}]`, data.toString());
        });

        this.connected_ = true;
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Kill the child process and clear all pending requests.
   */
  async disconnect(): Promise<void> {
    if (this.process_ && !this.process_.killed) {
      this.process_.kill();
    }
    this.process_ = null;
    this.connected_ = false;
    this.rejectAllPending(new Error("Transport disconnected"));
  }

  /**
   * Send a JSON-RPC call via stdin and return the response promise.
   */
  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 120_000,
  ): Promise<unknown> {
    if (!this.process_ || !this.process_.stdin?.writable) {
      throw new Error("Transport is not connected");
    }

    const id = ++this.messageId;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC call timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const request =
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }) + "\n";

      try {
        this.process_!.stdin!.write(request, "utf-8");
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /** Check if the transport is currently connected */
  isConnected(): boolean {
    return this.connected_ && this.process_ !== null && !this.process_.killed;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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
          parsed.jsonrpc === "2.0" &&
          typeof parsed.id === "number"
        ) {
          const pending = this.pendingRequests.get(parsed.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(parsed.id);
            if (parsed.error) {
              pending.reject(
                new Error(
                  (parsed.error as { message?: string }).message ??
                    "JSON-RPC error",
                ),
              );
            } else {
              pending.resolve(parsed.result);
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
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
