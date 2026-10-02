import * as fs from 'fs/promises';
import z from 'zod';
import { parseJson } from '../utils/json.js';
import { getDynamindPath } from '../utils/constants.js';

export const Oauth = z.object({
  type: z.literal('oauth'),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
  accountId: z.string().optional(),
});

export const Api = z.object({
  type: z.literal('api'),
  key: z.string(),
});

export const WellKnown = z.object({
  type: z.literal('wellknown'),
  key: z.string(),
  token: z.string(),
});

export const Info = z.discriminatedUnion('type', [Oauth, Api, WellKnown]);
export type Info = z.infer<typeof Info>;

const filepath = getDynamindPath('auth.json');

export async function get(providerID: string): Promise<Info | undefined> {
  const auth = await all();
  return auth[providerID];
}

export async function all(): Promise<Record<string, Info>> {
  try {
    const content = await fs.readFile(filepath, 'utf-8');
    const data = parseJson<Record<string, unknown>>(content);
    if (!data) return {};
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value);
        if (!parsed.success) return acc;
        acc[key] = parsed.data;
        return acc;
      },
      {} as Record<string, Info>
    );
  } catch {
    return {};
  }
}

export async function set(key: string, info: Info): Promise<void> {
  const data = await all();
  const content = JSON.stringify({ ...data, [key]: info }, null, 2);
  // CRITICAL: Write with restrictive permissions atomically to prevent TOCTOU race
  await fs.writeFile(filepath, content, { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(filepath, 0o600);
}

export async function remove(key: string): Promise<void> {
  const data = await all();
  delete data[key];
  const content = JSON.stringify(data, null, 2);
  // CRITICAL: Write with restrictive permissions atomically to prevent TOCTOU race
  await fs.writeFile(filepath, content, { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(filepath, 0o600);
}

export const Auth = {
  Oauth,
  Api,
  WellKnown,
  Info,
  get,
  all,
  set,
  remove,
};

