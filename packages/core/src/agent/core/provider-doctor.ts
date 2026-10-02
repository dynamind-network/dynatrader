/**
 * Provider Reliability & Diagnostics
 *
 * Tracks provider capabilities, handles stream failures, and provides diagnostic output.
 */

import type { ModelProvider, ModelRequest, ModelStreamChunk } from "@dyna/contracts";

export interface ProviderCapabilities {
  id: string;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  supportsThinking: boolean;
  maxTemperature: number;
}

export interface ProviderHealth {
  providerId: string;
  lastError?: string;
  lastErrorTime?: number;
  lastSuccess?: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  totalCalls: number;
  totalFailures: number;
}

export interface DiagnosisResult {
  provider: string;
  streamingSupported: boolean;
  toolUseSupported: boolean;
  lastError?: string;
  lastSuccess?: number;
  avgLatencyMs: number;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  healthy: boolean;
}

export class ProviderDoctor {
  private health: Map<string, ProviderHealth> = new Map();
  private capabilities: Map<string, ProviderCapabilities> = new Map();

  registerCapabilities(caps: ProviderCapabilities): void {
    this.capabilities.set(caps.id, caps);
    if (!this.health.has(caps.id)) {
      this.health.set(caps.id, {
        providerId: caps.id,
        consecutiveFailures: 0,
        avgLatencyMs: 0,
        totalCalls: 0,
        totalFailures: 0,
      });
    }
  }

  recordSuccess(providerId: string, latencyMs: number): void {
    const h = this.getHealth(providerId);
    h.lastSuccess = Date.now();
    h.consecutiveFailures = 0;
    h.totalCalls++;
    h.avgLatencyMs = h.totalCalls === 1
      ? latencyMs
      : h.avgLatencyMs + (latencyMs - h.avgLatencyMs) / h.totalCalls;
  }

  recordFailure(providerId: string, error: string): void {
    const h = this.getHealth(providerId);
    h.lastError = error;
    h.lastErrorTime = Date.now();
    h.consecutiveFailures++;
    h.totalCalls++;
    h.totalFailures++;
  }

  getCapabilities(providerId: string): ProviderCapabilities | undefined {
    return this.capabilities.get(providerId);
  }

  diagnose(providerId: string): DiagnosisResult {
    const h = this.getHealth(providerId);
    const caps = this.capabilities.get(providerId);
    return {
      provider: providerId,
      streamingSupported: caps?.supportsStreaming ?? false,
      toolUseSupported: caps?.supportsToolUse ?? false,
      lastError: h.lastError,
      lastSuccess: h.lastSuccess,
      avgLatencyMs: Math.round(h.avgLatencyMs),
      consecutiveFailures: h.consecutiveFailures,
      totalCalls: h.totalCalls,
      totalFailures: h.totalFailures,
      healthy: h.consecutiveFailures < 3,
    };
  }

  diagnoseAll(): DiagnosisResult[] {
    return Array.from(this.capabilities.keys()).map(id => this.diagnose(id));
  }

  isHealthy(providerId: string): boolean {
    return this.getHealth(providerId).consecutiveFailures < 3;
  }

  private getHealth(providerId: string): ProviderHealth {
    if (!this.health.has(providerId)) {
      this.health.set(providerId, {
        providerId,
        consecutiveFailures: 0,
        avgLatencyMs: 0,
        totalCalls: 0,
        totalFailures: 0,
      });
    }
    return this.health.get(providerId)!;
  }
}

/**
 * Wraps a provider stream with retry logic for transient errors.
 */
export async function* streamWithRetry(
  provider: ModelProvider,
  request: ModelRequest,
  maxRetries: number = 1,
): AsyncGenerator<ModelStreamChunk> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (!provider.stream) {
        // Fallback to non-streaming
        const response = await provider.call(request);
        if (response.content) yield { type: "content", content: response.content };
        if (response.toolCalls) {
          for (const tc of response.toolCalls) yield { type: "tool_call", toolCall: tc };
        }
        yield { type: "done", usage: response.usage };
        return;
      }
      
      let hasYielded = false;
      for await (const chunk of provider.stream(request)) {
        hasYielded = true;
        yield chunk;
      }
      if (hasYielded) return; // Success
    } catch (error) {
      lastError = error as Error;
      const msg = lastError.message;
      const isTransient = msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT") || 
                          msg.includes("socket hang up") || msg.includes("network");
      
      if (!isTransient || attempt >= maxRetries) {
        throw lastError;
      }
      // Wait before retry
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  
  if (lastError) throw lastError;
}
