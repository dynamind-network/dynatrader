/**
 * WebhookRuntime
 *
 * Processes inbound webhooks (verifies signatures, checks allowlists,
 * maps events to actions) and sends outbound webhooks (signs payloads,
 * respects allowlists).
 *
 * Signature verification uses HMAC-SHA256 with timing-safe comparison.
 * Source allowlisting supports IP and domain matching.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for an individual webhook source (inbound) or target
 * (outbound).
 */
export interface WebhookSourceConfig {
  /** Unique identifier for this source/target. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Shared secret used for HMAC-SHA256 signing. */
  secret: string;
  /** Optional allowlist of source IPs (exact match). */
  allowedIps?: string[];
  /** Optional allowlist of allowed domains/callers (suffix match). */
  allowedDomains?: string[];
  /** Maps incoming webhook event names to internal action names. */
  actionMappings?: Record<string, string>;
}

/** Payload supplied to {@link WebhookRuntime.processInbound}. */
export interface InboundWebhookPayload {
  /** Source identifier matching a registered {@link WebhookSourceConfig.id}. */
  source: string;
  /** Event name (e.g. "order.filled"). */
  event: string;
  /** ISO-8601 timestamp of when the webhook was sent. */
  timestamp?: string;
  /** Arbitrary payload data. */
  data: Record<string, unknown>;
  /** HMAC-SHA256 hex signature (from X-Webhook-Signature header). */
  signature?: string;
  /** Raw request body used to verify `signature`. */
  rawBody?: string;
}

/** Payload supplied to {@link WebhookRuntime.sendOutbound}. */
export interface OutboundWebhookPayload {
  /** Target URL to POST to. */
  url: string;
  /** Event name to send. */
  event: string;
  /** Arbitrary payload data. */
  data: Record<string, unknown>;
  /** Shared secret for signing. Defaults to the first source's secret. */
  secret?: string;
}

/** Result returned by inbound/outbound webhook operations. */
export interface WebhookResult {
  success: boolean;
  /** Mapped internal action (inbound only). */
  action?: string;
  /** Event that was processed. */
  event?: string;
  /** Unique operation identifier. */
  id: string;
  /** Human-readable error description (if any). */
  error?: string;
  /** HTTP status code from processing / remote response. */
  statusCode?: number;
  /** Response body from remote (outbound only). */
  responseBody?: string;
}

/** Options for constructing a {@link WebhookRuntime}. */
export interface WebhookRuntimeOptions {
  /** Pre-configured webhook sources/targets. */
  sources: WebhookSourceConfig[];
  /** Default timeout in ms for outbound requests (default: 10_000). */
  defaultTimeout?: number;
  /** Maximum retries for failed outbound deliveries (default: 3). */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// WebhookRuntime
// ---------------------------------------------------------------------------

export class WebhookRuntime {
  private readonly sources: Map<string, WebhookSourceConfig>;
  private readonly defaultTimeout: number;
  private readonly maxRetries: number;

  constructor(options: WebhookRuntimeOptions) {
    this.sources = new Map(
      options.sources.map((s) => [s.id, s] as const),
    );
    this.defaultTimeout = options.defaultTimeout ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  // -----------------------------------------------------------------------
  // Source management
  // -----------------------------------------------------------------------

  /** Retrieve a registered source config by id. */
  getSource(id: string): WebhookSourceConfig | undefined {
    return this.sources.get(id);
  }

  /** Register or update a webhook source. */
  addSource(source: WebhookSourceConfig): void {
    this.sources.set(source.id, source);
  }

  /** Remove a registered source. Returns true if it existed. */
  removeSource(id: string): boolean {
    return this.sources.delete(id);
  }

  /** Return all registered source configs. */
  getSources(): WebhookSourceConfig[] {
    return Array.from(this.sources.values());
  }

  // -----------------------------------------------------------------------
  // Signature verification
  // -----------------------------------------------------------------------

  /**
   * Verify an HMAC-SHA256 signature using a timing-safe comparison.
   *
   * @param payload - The raw body that was signed.
   * @param signature - The hex-encoded HMAC to verify against.
   * @param secret - The shared secret.
   * @returns `true` if the signature matches, `false` otherwise.
   */
  verifySignature(payload: string, signature: string, secret: string): boolean {
    const expected = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "utf8");
    const sigBuf = Buffer.from(signature, "utf8");

    if (expectedBuf.length !== sigBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, sigBuf);
  }

  // -----------------------------------------------------------------------
  // Source allowlisting
  // -----------------------------------------------------------------------

  /**
   * Check whether a given source is allowed to send/receive webhooks based
   * on its IP address or domain suffix.
   *
   * If a source has no IP or domain allowlist configured, any caller is
   * permitted.  If an allowlist exists but the corresponding parameter is
   * not provided, the check returns `false`.
   */
  isSourceAllowed(
    sourceId: string,
    ip?: string,
    domain?: string,
  ): boolean {
    const source = this.sources.get(sourceId);
    if (!source) return false;

    if (source.allowedIps && source.allowedIps.length > 0) {
      if (!ip) return false;
      if (!source.allowedIps.includes(ip)) return false;
    }

    if (source.allowedDomains && source.allowedDomains.length > 0) {
      if (!domain) return false;
      const allowed = source.allowedDomains.some((d) =>
        domain.endsWith(d),
      );
      if (!allowed) return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Action mapping
  // -----------------------------------------------------------------------

  /**
   * Map an incoming webhook event name to an internal action using the
   * source's configured action mappings.
   */
  mapEventToAction(sourceId: string, event: string): string | undefined {
    const source = this.sources.get(sourceId);
    if (!source?.actionMappings) return undefined;
    return source.actionMappings[event];
  }

  // -----------------------------------------------------------------------
  // Inbound processing
  // -----------------------------------------------------------------------

  /**
   * Process an incoming webhook:
   *  1. Look up the source config.
   *  2. Check IP/domain allowlist.
   *  3. Verify HMAC-SHA256 signature (if provided).
   *  4. Map event to internal action.
   */
  async processInbound(
    payload: InboundWebhookPayload,
    meta?: { ip?: string; domain?: string },
  ): Promise<WebhookResult> {
    const id = generateId();
    const source = this.sources.get(payload.source);

    // -- Source exists --
    if (!source) {
      return {
        success: false,
        id,
        error: `Unknown webhook source: "${payload.source}"`,
        statusCode: 400,
      };
    }

    // -- Allowlist check --
    if (!this.isSourceAllowed(payload.source, meta?.ip, meta?.domain)) {
      return {
        success: false,
        id,
        error: "Source not allowed (IP/domain not in allowlist)",
        statusCode: 403,
      };
    }

    // -- Signature verification --
    if (payload.signature !== undefined && payload.rawBody !== undefined) {
      const valid = this.verifySignature(
        payload.rawBody,
        payload.signature,
        source.secret,
      );
      if (!valid) {
        return {
          success: false,
          id,
          error: "Signature verification failed",
          statusCode: 401,
        };
      }
    }

    // -- Action mapping --
    const action = this.mapEventToAction(payload.source, payload.event);
    if (action === undefined) {
      return {
        success: false,
        id,
        error: `No action mapping for event: "${payload.event}"`,
        statusCode: 400,
      };
    }

    return {
      success: true,
      action,
      event: payload.event,
      id,
      statusCode: 200,
    };
  }

  // -----------------------------------------------------------------------
  // Outbound sending
  // -----------------------------------------------------------------------

  /**
   * Send an outbound webhook to a remote URL.  The payload is signed with
   * HMAC-SHA256 and delivered via POST.
   */
  async sendOutbound(payload: OutboundWebhookPayload): Promise<WebhookResult> {
    const id = generateId();

    if (!payload.secret) {
      return {
        success: false,
        id,
        error: "No secret provided for outbound webhook signing",
        statusCode: 400,
      };
    }

    // Sign the payload
    const body = JSON.stringify({ event: payload.event, data: payload.data });
    const signature = createHmac("sha256", payload.secret)
      .update(body)
      .digest("hex");

    // Deliver with retries
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.deliver(
          id,
          payload.url,
          signature,
          payload.event,
          body,
        );
        if (result.success || attempt === this.maxRetries) {
          return result;
        }
      } catch (err: unknown) {
        if (attempt === this.maxRetries) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            event: payload.event,
            id,
            error: `Webhook delivery failed after ${this.maxRetries + 1} attempt(s): ${message}`,
          };
        }
      }
    }

    return {
      success: false,
      event: payload.event,
      id,
      error: "Webhook delivery exhausted retries",
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Perform a single HTTP POST delivery attempt.
   */
  private async deliver(
    id: string,
    url: string,
    signature: string,
    event: string,
    body: string,
  ): Promise<WebhookResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Event": event,
        },
        body,
        signal: controller.signal,
      });

      const responseBody = await response.text();

      if (!response.ok) {
        return {
          success: false,
          event,
          id,
          statusCode: response.status,
          error: `Remote returned status ${response.status}`,
          responseBody,
        };
      }

      return {
        success: true,
        event,
        id,
        statusCode: response.status,
        responseBody,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Generate a short, unique webhook operation identifier. */
function generateId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}
