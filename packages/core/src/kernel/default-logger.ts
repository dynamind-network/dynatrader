/**
 * Default kernel logger.
 *
 * Console-based fallback satisfying the KernelLogger interface so the kernel
 * has zero external dependencies. Callers can pass a richer logger (e.g.
 * @dyna/audit Logger) via KernelOptions — it only needs to satisfy the
 * same four methods.
 */

import type { KernelLogger } from "./types";

export class DefaultKernelLogger implements KernelLogger {
  constructor(private readonly context: string) {}

  debug(message: string, meta?: unknown): void {
    console.debug(`[${this.context}] ${message}`, meta ?? "");
  }

  info(message: string, meta?: unknown): void {
    console.info(`[${this.context}] ${message}`, meta ?? "");
  }

  warn(message: string, meta?: unknown): void {
    console.warn(`[${this.context}] ${message}`, meta ?? "");
  }

  error(message: string, meta?: unknown): void {
    console.error(`[${this.context}] ${message}`, meta ?? "");
  }
}
