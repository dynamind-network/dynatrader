/**
 * HttpTransport for MCP (Model Context Protocol)
 *
 * Connects to a remote MCP server via HTTP POST with JSON-RPC 2.0 messages.
 * Supports SSE (Server-Sent Events) for notifications.
 *
 * Features:
 * - JSON-RPC over HTTP POST
 * - SSE stream reading for server notifications
 * - Configurable timeout (default 30s)
 * - Connection health check (periodic ping)
 * - AbortController support for request cancellation
 */

import type {
  MCPServerConfig,
  MCPJsonRpcRequest,
  MCPJsonRpcResponse,
  MCPTransport,
} from "./mcp-types";

// ---------------------------------------------------------------------------
// SSE Event parsing
// ---------------------------------------------------------------------------

interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Parse an SSE (Server-Sent Events) stream from a ReadableStream<Uint8Array>.
 * Yields parsed SSE events as they arrive.
 */
async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? ""; // Keep incomplete part in buffer

      for (const part of parts) {
        if (!part.trim()) continue;

        const event: SSEEvent = { data: "" };
        const lines = part.split("\n");

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            event.event = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            event.data = line.slice(6);
          } else if (line.startsWith("id: ")) {
            event.id = line.slice(4).trim();
          } else if (line.startsWith(":")) {
            // Comment line, ignore
          }
        }

        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// HttpTransport
// ---------------------------------------------------------------------------

export class HttpTransport implements MCPTransport {
  private connected_: boolean = false;
  private messageId: number = 0;
  private notificationHandlers: Array<
    (notification: { method: string; params?: unknown }) => void
  > = [];
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;
  private sseReader: Promise<void> | null = null;

  constructor(
    private config: MCPServerConfig,
    private options: {
      timeoutMs?: number;
      healthCheckIntervalMs?: number;
      headers?: Record<string, string>;
    } = {},
  ) {}

  /**
   * Connect to the remote MCP server.
   * For HTTP transport, this verifies the server is reachable and
   * starts listening for SSE notifications.
   */
  async connect(): Promise<void> {
    const url = this.config.url;
    if (!url) {
      throw new Error("HTTP transport requires a 'url' in server config");
    }

    this.abortController = new AbortController();

    try {
      // First, verify the server is reachable with a ping/initialize
      const initRequest: MCPJsonRpcRequest = {
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "dynatrader-mcp",
            version: "2.0.0",
          },
        },
      };

      await this.sendJsonRpc(url, initRequest);

      this.connected_ = true;

      // Start SSE listener for notifications (if the server supports streaming)
      this.startSSEListener(url);

      // Start health check pings
      this.startHealthCheck(url);

      console.debug(`[HttpTransport:${this.config.name}] Connected to ${url}`);
    } catch (err) {
      this.connected_ = false;
      throw err;
    }
  }

  /**
   * Disconnect from the remote MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.connected_ = false;

    // Wait for SSE reader to finish
    if (this.sseReader) {
      try {
        await this.sseReader;
      } catch {
        // Ignore abort errors
      }
      this.sseReader = null;
    }

    console.debug(`[HttpTransport:${this.config.name}] Disconnected`);
  }

  /**
   * Send a JSON-RPC request and return the response.
   */
  async send(request: MCPJsonRpcRequest): Promise<MCPJsonRpcResponse> {
    const url = this.config.url;
    if (!url) {
      throw new Error("HTTP transport requires a 'url' in server config");
    }
    if (!this.connected_) {
      throw new Error("Transport is not connected");
    }

    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const id =
      typeof request.id === "number"
        ? request.id
        : ++this.messageId;

    const payload: MCPJsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: request.method,
      params: request.params,
    };

    return this.sendJsonRpc(url, payload, timeoutMs);
  }

  /** Check if the transport is currently connected */
  isConnected(): boolean {
    return this.connected_;
  }

  /**
   * Register a handler for notifications from the server.
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
   * Send a JSON-RPC request via HTTP POST and parse the response.
   */
  private async sendJsonRpc(
    url: string,
    request: MCPJsonRpcRequest,
    timeoutMs?: number,
  ): Promise<MCPJsonRpcResponse> {
    const effectiveTimeout = timeoutMs ?? this.options.timeoutMs ?? 120_000;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.options.headers,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(effectiveTimeout),
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${response.statusText} - ${await response.text().catch(() => "unknown")}`,
      );
    }

    const body = (await response.json()) as MCPJsonRpcResponse;

    if (body.error) {
      throw new Error(
        `JSON-RPC error [${body.error.code}]: ${body.error.message}`,
      );
    }

    return body;
  }

  /**
   * Start an SSE listener for server notifications.
   * The server may push notifications via an SSE stream.
   */
  private startSSEListener(url: string): void {
    // Try connecting to an SSE endpoint (convention: /sse or the base URL)
    const sseUrl = url.replace(/\/+$/, "") + "/sse";

    this.sseReader = this.readSSEStream(sseUrl).catch((err) => {
      // If SSE endpoint doesn't exist, that's fine - notifications
      // may come piggybacked on responses instead
      if (
        err instanceof Error &&
        !err.message.includes("404") &&
        !err.message.includes("abort")
      ) {
        console.debug(
          `[HttpTransport:${this.config.name}] SSE not available: ${err.message}`,
        );
      }
    });
  }

  /**
   * Read SSE stream from the server and dispatch notifications.
   */
  private async readSSEStream(url: string): Promise<void> {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...this.options.headers,
      },
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE endpoint returned ${response.status}`);
    }

    if (!response.body) {
      throw new Error("SSE response has no body stream");
    }

    for await (const event of parseSSEStream(response.body)) {
      if (event.event === "message" || event.event === "notification") {
        try {
          const parsed = JSON.parse(event.data);
          const notification = {
            method: (parsed as { method?: string }).method ?? "",
            params: (parsed as { params?: unknown }).params,
          };
          this.dispatchNotification(notification);
        } catch {
          // Invalid JSON in SSE data, ignore
        }
      }
    }
  }

  /**
   * Start periodic health check pings.
   */
  private startHealthCheck(url: string): void {
    const intervalMs = this.options.healthCheckIntervalMs ?? 30000;

    this.healthCheckTimer = setInterval(async () => {
      try {
        const pingRequest: MCPJsonRpcRequest = {
          jsonrpc: "2.0",
          id: "ping",
          method: "ping",
        };

        await this.sendJsonRpc(url, pingRequest, 5000);
      } catch (err) {
        console.error(
          `[HttpTransport:${this.config.name}] Health check failed:`,
          err,
        );
        this.connected_ = false;
      }
    }, intervalMs);

    // Allow the process to exit even if this timer is still running
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  /**
   * Dispatch a notification to all registered handlers.
   */
  private dispatchNotification(notification: {
    method: string;
    params?: unknown;
  }): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch {
        // Handler errors are silently caught
      }
    }
  }
}