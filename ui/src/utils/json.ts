/**
 * JSON utility functions
 */

/**
 * Stringify an object to JSON with pretty formatting (2-space indent)
 */
export function stringifyJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Safely parse JSON string, returning undefined on failure instead of throwing
 */
export function parseJson<T>(json: string): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}
