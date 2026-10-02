/**
 * Trading Halt State (Kill Switch)
 *
 * Persistent, scoped halt state enforced by the ExecutionRouter before any
 * order is placed. Survives daemon restarts. Halt/resume can be triggered by
 * the agent (risk tools), the CLI (`dyna halt`), or Telegram (`/halt`).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

export type HaltScope = "global" | { symbol: string };

export interface HaltRecord {
  id: string;
  scope: HaltScope;
  reason: string;
  source: "agent" | "telegram" | "cli" | "system";
  createdAt: number;
}

interface HaltFile {
  halted: HaltRecord[];
}

/**
 * Manages persistent trading-halt records.
 * A halt blocks all executions globally or for a specific symbol until resumed.
 */
export class HaltState {
  private filePath: string;
  private records: HaltRecord[] = [];

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "halt.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as HaltFile;
        this.records = Array.isArray(parsed.halted) ? parsed.halted : [];
        return;
      }
    } catch {
      // Corrupt file: start clean rather than blocking forever
    }
    this.records = [];
  }

  private save(): void {
    mkdirSync(this.filePath.slice(0, this.filePath.lastIndexOf(this.filePath.includes("\\") ? "\\" : "/")), {
      recursive: true,
    });
    writeFileSync(this.filePath, JSON.stringify({ halted: this.records }, null, 2), "utf-8");
  }

  /**
   * Activate a trading halt. Returns the created record.
   */
  halt(reason: string, source: HaltRecord["source"], scope: HaltScope = "global"): HaltRecord {
    // Idempotent: don't stack duplicate identical halts
    const existing = this.records.find(
      (r) =>
        r.scope === scope &&
        r.reason === reason &&
        r.source === source,
    );
    if (existing) return existing;

    const record: HaltRecord = {
      id: randomUUID(),
      scope,
      reason,
      source,
      createdAt: Date.now(),
    };
    this.records.push(record);
    this.save();
    return record;
  }

  /**
   * Lift halts. With no argument lifts all; with a symbol only that symbol's halt.
   */
  resume(scope?: HaltScope): number {
    if (!scope) {
      const n = this.records.length;
      this.records = [];
      this.save();
      return n;
    }
    const before = this.records.length;
    if (scope === "global") {
      // A global-scope resume lifts only records whose scope is exactly "global"
      this.records = this.records.filter((r) => typeof r.scope === "object");
    } else {
      const sym = scope.symbol;
      this.records = this.records.filter(
        (r) => !(typeof r.scope === "object" && r.scope.symbol === sym),
      );
    }
    const removed = before - this.records.length;
    this.save();
    return removed;
  }

  /**
   * Check whether trading is currently blocked. Returns the matching halt
   * record(s) — empty array means trading is allowed.
   */
  check(symbol?: string): HaltRecord[] {
    return this.records.filter((r) => {
      if (r.scope === "global") return true;
      return symbol !== undefined && r.scope.symbol === symbol;
    });
  }

  isHalted(symbol?: string): boolean {
    return this.check(symbol).length > 0;
  }

  list(): HaltRecord[] {
    return [...this.records];
  }
}
