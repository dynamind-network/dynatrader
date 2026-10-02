import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDynaMindApi } from "./http.js";

afterEach(() => vi.unstubAllGlobals());

const config = { baseUrl: "https://api.example.test", apiKey: "test-key" };

describe("shared DynaMind HTTP client", () => {
  it("sends auth, JSON body, method, and timeout while unwrapping data envelopes", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ success: true, data: { value: 7 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestDynaMindApi(config, "/thing", {
      method: "POST", body: { query: "x" }, timeoutMs: 2345,
    })).resolves.toEqual({ value: 7 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    expect(init?.body).toBe('{"query":"x"}');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts unwrapped payloads and rejects unsuccessful envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ value: 3 }))
      .mockResolvedValueOnce(Response.json({ success: false, message: "quota exhausted" })));
    await expect(requestDynaMindApi(config, "/raw", { timeoutMs: 1000 })).resolves.toEqual({ value: 3 });
    await expect(requestDynaMindApi(config, "/failed", { timeoutMs: 1000 }))
      .rejects.toThrow("unsuccessful response: quota exhausted");
  });

  it.each([
    [401, "invalid", "key is missing or invalid"],
    [402, "payment", "not included in your current plan"],
    [429, "rate", "rate limit reached"],
  ])("explains HTTP %i plan response", async (status, _label, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status,
      statusText: "Rejected",
      headers: status === 429 ? { "Retry-After": "37" } : undefined,
    })));
    const result = requestDynaMindApi(config, "/restricted", { timeoutMs: 1000 });
    await expect(result).rejects.toThrow(expected);
    if (status === 429) await expect(result).rejects.toThrow("Retry after 37");
  });

  it("reports ordinary HTTP status and includes the endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503, statusText: "Unavailable" })));
    await expect(requestDynaMindApi(config, "/down", { timeoutMs: 1000 }))
      .rejects.toThrow("DynaMind API 503: Unavailable (/down)");
  });

  it.each([
    [new DOMException("aborted", "TimeoutError"), "timed out after 1200ms"],
    [new TypeError("connection refused"), "request failed (/down): connection refused"],
  ])("normalizes network failures", async (failure, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw failure; }));
    await expect(requestDynaMindApi(config, "/down", { timeoutMs: 1200 })).rejects.toThrow(expected);
  });

  it("reports invalid JSON with the endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 200 })));
    await expect(requestDynaMindApi(config, "/json", { timeoutMs: 1000 }))
      .rejects.toThrow("DynaMind API returned invalid JSON (/json)");
  });
});
