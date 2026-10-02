import * as fs from 'fs/promises';
import * as path from 'path';
import { PROVIDERS, Auth } from '../index.js';
import { getDynamindPath } from '../utils/constants.js';

export function validateAPIKey(provider: string, key: string): boolean {
  if (!key || key.length < 10) {
    return false;
  }

  const providerKeys: Record<string, RegExp> = {
    anthropic: /^sk-ant-[a-zA-Z0-9_-]+$/,
    deepseek: /^sk-[a-zA-Z0-9_-]+$/,
    glm: /^[a-zA-Z0-9._-]+$/,
    openai: /^sk-[a-zA-Z0-9_-]+$/,
  };

  const pattern = providerKeys[provider];
  if (!pattern) {
    return false;
  }

  return pattern.test(key);
}

export async function testAPIKey(
  provider: string,
  key: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!validateAPIKey(provider, key)) {
      return { success: false, error: 'Invalid API key format' };
    }

    const providerEntry = PROVIDERS[provider];
    if (!providerEntry?.baseUrl) {
      return { success: false, error: 'Unknown provider' };
    }
    const baseUrl = providerEntry.baseUrl;

    // OpenAI: GET /models; Anthropic: POST /v1/messages; others: POST /chat/completions
    if (provider === 'openai') {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        return {
          success: false,
          error: `API test failed: ${response.status} ${error}`,
        };
      }
    } else {
      const isAnthropic = provider === 'anthropic';
      const testUrl = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;

      const response = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isAnthropic
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          model: providerEntry.defaultModel || 'gpt-4o-mini',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        return {
          success: false,
          error: `API test failed: ${response.status} ${error}`,
        };
      }
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export function formatProviderName(provider: string): string {
  return PROVIDERS[provider]?.displayName || provider;
}

export async function checkExistingConfig(): Promise<{
  hasAuth: boolean;
  hasConfig: boolean;
}> {
  const authPath = getDynamindPath('auth.json');
  const configPath = getDynamindPath('config.json');

  try {
    const [authExists, configExists] = await Promise.all([
      fs
        .access(authPath)
        .then(() => true)
        .catch(() => false),
      fs
        .access(configPath)
        .then(() => true)
        .catch(() => false),
    ]);

    return { hasAuth: authExists, hasConfig: configExists };
  } catch {
    return { hasAuth: false, hasConfig: false };
  }
}

