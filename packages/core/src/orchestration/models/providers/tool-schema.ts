export function normalizeToolProperty(value: unknown): { schema: Record<string, unknown>; optional: boolean } {
  if (typeof value === 'string') {
    const optional = value.endsWith('?');
    const type = optional ? value.slice(0, -1) : value;
    return { schema: { type: type === 'any' ? 'string' : type }, optional };
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    const optional = input['optional'] === true;
    const schema = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'optional'));
    if (schema['type'] === 'any') schema['type'] = 'string';
    return { schema, optional };
  }

  return { schema: { type: 'string' }, optional: false };
}

export function normalizeToolParameters(inputSchema: Record<string, unknown>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(inputSchema)) {
    const normalized = normalizeToolProperty(value);
    properties[key] = normalized.schema;
    if (!normalized.optional) required.push(key);
  }
  return { properties, required };
}

export function toGoogleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGoogleSchema);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = key === 'type' && typeof item === 'string'
      ? (item === 'any' ? 'STRING' : item.toUpperCase())
      : toGoogleSchema(item);
  }
  return result;
}
