/**
 * WebhookRuntime Tests
 *
 * Covers: source management, signature verification, allowlisting,
 * action mapping, inbound processing (success + all error paths),
 * outbound sending (success + error paths), and edge cases.
 * 13 tests total.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  WebhookRuntime,
  type WebhookSourceConfig,
  type InboundWebhookPayload,
} from "./webhook-runtime";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SOURCE: WebhookSourceConfig = {
  id: "github",
  name: "GitHub Webhooks",
  secret: "gh_secret_abc123",
  allowedIps: ["192.168.1.1", "10.0.0.1"],
  allowedDomains: ["github.com", "api.github.com"],
  actionMappings: {
    "push": "strategy.sync",
    "pull_request.opened": "strategy.review",
    "issues.opened": "issue.triage",
  },
};

const TEST_SOURCE_NO_ALLOWLIST: WebhookSourceConfig = {
  id: "generic",
  name: "Generic Webhook",
  secret: "generic_secret_xyz",
  actionMappings: {
    ping: "health.check",
  },
};

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeInboundPayload(
  overrides: Partial<InboundWebhookPayload> & { source: string; event: string },
  secret?: string,
): InboundWebhookPayload {
  const rawBody = JSON.stringify(overrides.data ?? {});
  const payload: InboundWebhookPayload = {
    source: overrides.source,
    event: overrides.event,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    data: overrides.data ?? {},
    signature: overrides.signature,
    rawBody: overrides.rawBody ?? rawBody,
  };
  // Compute signature if secret given and no explicit signature
  if (secret !== undefined && payload.signature === undefined) {
    payload.signature = signBody(payload.rawBody!, secret);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("WebhookRuntime", () => {
  let runtime: WebhookRuntime;

  beforeEach(() => {
    runtime = new WebhookRuntime({
      sources: [TEST_SOURCE, TEST_SOURCE_NO_ALLOWLIST],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Source management
  // -----------------------------------------------------------------------

  describe("source management", () => {
    it("should retrieve a registered source by id", () => {
      const source = runtime.getSource("github");
      expect(source).toBeDefined();
      expect(source!.id).toBe("github");
      expect(source!.name).toBe("GitHub Webhooks");
    });

    it("should return undefined for an unknown source", () => {
      const source = runtime.getSource("nonexistent");
      expect(source).toBeUndefined();
    });

    it("should add and remove sources dynamically", () => {
      const newSource: WebhookSourceConfig = {
        id: "custom",
        name: "Custom",
        secret: "custom_secret",
      };

      runtime.addSource(newSource);
      expect(runtime.getSource("custom")).toBeDefined();

      const removed = runtime.removeSource("custom");
      expect(removed).toBe(true);
      expect(runtime.getSource("custom")).toBeUndefined();
    });

    it("should return false when removing a non-existent source", () => {
      const removed = runtime.removeSource("phantom");
      expect(removed).toBe(false);
    });

    it("should return all registered sources", () => {
      const all = runtime.getSources();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.id).sort()).toEqual(["generic", "github"]);
    });
  });

  // -----------------------------------------------------------------------
  // Signature verification
  // -----------------------------------------------------------------------

  describe("signature verification", () => {
    it("should verify a valid HMAC-SHA256 signature", () => {
      const body = '{"hello":"world"}';
      const signature = signBody(body, "mysecret");
      expect(runtime.verifySignature(body, signature, "mysecret")).toBe(true);
    });

    it("should reject an invalid HMAC-SHA256 signature", () => {
      const body = '{"hello":"world"}';
      const signature = signBody(body, "mysecret");
      expect(runtime.verifySignature(body, signature, "wrongsecret")).toBe(false);
    });

    it("should reject a signature with wrong length", () => {
      // timingSafeEqual would throw on mismatched lengths, so we test
      // our early-return guard
      const body = '{"hello":"world"}';
      const shortSig = "abc";
      expect(runtime.verifySignature(body, shortSig, "mysecret")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Source allowlisting
  // -----------------------------------------------------------------------

  describe("source allowlisting", () => {
    it("should allow a source with matching IP and domain", () => {
      expect(
        runtime.isSourceAllowed("github", "192.168.1.1", "api.github.com"),
      ).toBe(true);
    });

    it("should deny a source with non-matching IP", () => {
      expect(
        runtime.isSourceAllowed("github", "1.2.3.4", "api.github.com"),
      ).toBe(false);
    });

    it("should deny a source with non-matching domain", () => {
      expect(
        runtime.isSourceAllowed("github", "192.168.1.1", "evil.com"),
      ).toBe(false);
    });

    it("should allow a source with no allowlist configured", () => {
      expect(
        runtime.isSourceAllowed("generic", "1.2.3.4", "any.domain"),
      ).toBe(true);
    });

    it("should return false for an unknown source", () => {
      expect(runtime.isSourceAllowed("unknown")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Action mapping
  // -----------------------------------------------------------------------

  describe("action mapping", () => {
    it("should map an event to an action using the source config", () => {
      const action = runtime.mapEventToAction("github", "push");
      expect(action).toBe("strategy.sync");
    });

    it("should return undefined for unmapped events", () => {
      const action = runtime.mapEventToAction("github", "unknown.event");
      expect(action).toBeUndefined();
    });

    it("should return undefined for unknown sources", () => {
      const action = runtime.mapEventToAction("unknown", "push");
      expect(action).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Inbound processing
  // -----------------------------------------------------------------------

  describe("inbound processing", () => {
    it("should process a valid inbound webhook successfully", async () => {
      const payload = makeInboundPayload(
        { source: "github", event: "push", data: { ref: "main" } },
        TEST_SOURCE.secret,
      );

      const result = await runtime.processInbound(payload, {
        ip: "192.168.1.1",
        domain: "api.github.com",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("strategy.sync");
      expect(result.event).toBe("push");
      expect(result.id).toMatch(/^wh_/);
      expect(result.statusCode).toBe(200);
    });

    it("should reject an inbound webhook from an unknown source", async () => {
      const payload = makeInboundPayload({
        source: "unknown",
        event: "push",
      });

      const result = await runtime.processInbound(payload);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toContain("Unknown webhook source");
    });

    it("should reject an inbound webhook when IP is not in the allowlist", async () => {
      const payload = makeInboundPayload(
        { source: "github", event: "push" },
        TEST_SOURCE.secret,
      );

      const result = await runtime.processInbound(payload, {
        ip: "9.9.9.9",
        domain: "api.github.com",
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.error).toContain("not allowed");
    });

    it("should reject an inbound webhook with an invalid signature", async () => {
      const payload = makeInboundPayload(
        {
          source: "github",
          event: "push",
          data: { ref: "main" },
          signature: "invalid_sig_here",
        },
        undefined, // no secret-based auto-signing
      );

      const result = await runtime.processInbound(payload, {
        ip: "192.168.1.1",
        domain: "api.github.com",
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain("Signature verification failed");
    });

    it("should reject an inbound webhook with no action mapping", async () => {
      const payload = makeInboundPayload(
        { source: "github", event: "unmapped.event", data: {} },
        TEST_SOURCE.secret,
      );

      const result = await runtime.processInbound(payload, {
        ip: "192.168.1.1",
        domain: "api.github.com",
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toContain("No action mapping");
    });
  });

  // -----------------------------------------------------------------------
  // Outbound sending
  // -----------------------------------------------------------------------

  describe("outbound sending", () => {
    it("should fail with 400 when no secret is provided", async () => {
      const result = await runtime.sendOutbound({
        url: "https://example.com/hooks",
        event: "trade.filled",
        data: { symbol: "BTC/USD" },
        // No secret
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toContain("No secret");
    });

    it("should send a signed outbound webhook and return success", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"ok":true}'),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        const result = await runtime.sendOutbound({
          url: "https://example.com/hooks",
          event: "trade.filled",
          data: { symbol: "BTC/USD", price: 50000 },
          secret: "outbound_secret",
        });

        expect(result.success).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.id).toMatch(/^wh_/);

        // Verify fetch was called with the correct arguments
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0]!;
        expect(callArgs[0]).toBe("https://example.com/hooks");

        const requestInit = callArgs[1] as RequestInit;
        const headers = requestInit.headers as Record<string, string>;
        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers["X-Webhook-Event"]).toBe("trade.filled");
        expect(headers["X-Webhook-Signature"]).toBeDefined();

        // Verify the body is signed correctly
        const body = requestInit.body as string;
        const parsed = JSON.parse(body);
        expect(parsed.event).toBe("trade.filled");
        expect(parsed.data.symbol).toBe("BTC/USD");

        const expectedSig = createHmac("sha256", "outbound_secret")
          .update(body)
          .digest("hex");
        expect(headers["X-Webhook-Signature"]).toBe(expectedSig);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should report failure when the remote returns an error status", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        const result = await runtime.sendOutbound({
          url: "https://example.com/hooks",
          event: "trade.filled",
          data: { symbol: "BTC/USD" },
          secret: "outbound_secret",
        });

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(500);
        expect(result.error).toContain("Remote returned status 500");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
