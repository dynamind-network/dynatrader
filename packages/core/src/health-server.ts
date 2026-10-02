/**
 * HealthServer
 *
 * Tiny HTTP health check server for Docker / load balancer probes.
 *
 * Endpoints:
 * - GET / or /health → 200 JSON when healthy, 503 when status is "degraded"/"unhealthy"
 * - Everything else → 404
 */

import http from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthServerConfig {
  /** Port to listen on. Defaults to env HEALTH_PORT or 9090. */
  port?: number;
  /** Host to bind. Defaults to loopback (127.0.0.1) so the health endpoint is not exposed on public interfaces; set HEALTH_HOST=0.0.0.0 for containers. */
  host?: string;
  /** Optional callback to supply dynamic health info. */
  getHealthInfo?: () => {
    status: string;
    mode: string;
    components: number;
    startedAt?: Date;
    [key: string]: unknown;
  };
}

/** Statuses that map to HTTP 503 so orchestrators restart/replace the instance. */
const UNHEALTHY_STATUSES = new Set(["degraded", "unhealthy", "error"]);

// ---------------------------------------------------------------------------
// HealthServer
// ---------------------------------------------------------------------------

export class HealthServer {
  private server: http.Server | null = null;
  private readonly startedAt = Date.now();
  private readonly port: number;
  private readonly host: string;
  private readonly getHealthInfo: HealthServerConfig["getHealthInfo"];

  constructor(config: HealthServerConfig = {}) {
    this.port = config.port ?? parseInt(process.env["HEALTH_PORT"] ?? "9090", 10);
    this.host = config.host ?? process.env["HEALTH_HOST"] ?? "127.0.0.1";
    this.getHealthInfo = config.getHealthInfo;
  }

  /**
   * Start listening for HTTP requests.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.url === "/health" || req.url === "/") {
          const info = this.getHealthInfo?.() ?? { status: "ok", mode: "unknown", components: 0 };
          const statusCode = UNHEALTHY_STATUSES.has(info.status) ? 503 : 200;
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ...info,
              uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            }),
          );
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });
      this.server.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
