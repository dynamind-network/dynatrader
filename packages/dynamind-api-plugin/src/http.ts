/** Shared transport and response handling for DynaMind API providers. */

export interface DynaMindHttpConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface DynaMindRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs: number;
}

/**
 * Call a DynaMind endpoint and unwrap the API's optional { success, data }
 * envelope. Provider methods remain responsible for mapping endpoint fields.
 */
export async function requestDynaMindApi<T>(
  config: DynaMindHttpConfig,
  path: string,
  options: DynaMindRequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const failure = error as Error;
    if (failure?.name === "TimeoutError" || failure?.name === "AbortError") {
      throw new Error(`DynaMind API request timed out after ${options.timeoutMs}ms (${path}). Check API reachability or configure another provider.`);
    }
    throw new Error(`DynaMind API request failed (${path}): ${failure?.message ?? String(error)}`);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("DynaMind API key is missing or invalid. Start with the free, rate-limited plan: create a key at https://developer.dynamind.network/ and set DYNAMIND_API_KEY. See https://dynamind.network/pricing for higher limits. You can also configure another provider.");
    }
    if (response.status === 402) {
      throw new Error("This DynaMind API endpoint is not included in your current plan. The Free plan includes 1,000 requests/day for basic price data; historical OHLCV and additional endpoints require an eligible plan. See https://dynamind.network/pricing or configure another provider.");
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryHint = retryAfter ? ` Retry after ${retryAfter}.` : " Check when your plan quota resets.";
      throw new Error(`DynaMind API rate limit reached.${retryHint} The Free plan has a daily request limit. See https://dynamind.network/pricing for plan limits, or configure another provider.`);
    }
    throw new Error(`DynaMind API ${response.status}: ${response.statusText} (${path})`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`DynaMind API returned invalid JSON (${path}): ${(error as Error)?.message ?? String(error)}`);
  }

  if (isRecord(payload)) {
    if (payload.success === false) {
      const message = typeof payload.message === "string" ? `: ${payload.message}` : "";
      throw new Error(`DynaMind API returned an unsuccessful response${message} (${path})`);
    }
    if (Object.hasOwn(payload, "data")) return payload.data as T;
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
