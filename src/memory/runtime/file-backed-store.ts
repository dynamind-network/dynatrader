/**
 * FileBackedMemoryStore
 *
 * A persistent memory layer that bridges the in-memory MemoryStoreImpl to
 * file-backed storage.  Events are written as newline-delimited JSON (JSONL)
 * files with daily rotation:  workspace/memory/YYYY-MM-DD.jsonl.
 *
 * On construction, any existing JSONL files are loaded into the in-memory
 * store.  If filesystem operations fail the store degrades gracefully to
 * in-memory-only and logs a warning via the audit logger.
 */

import type { MemoryStore } from "@dyna/contracts";
import { InMemoryStore, type MemoryEvent, type SearchQuery } from "@dyna/memory-core";
import { Logger } from "@dyna/audit";
import * as fs from "fs/promises";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a single JSONL line when serialised to disk.
 */
interface PersistedEvent {
  id: string;
  scope: string;
  kind: string;
  payload: unknown;
  timestamp: string; // ISO-8601 string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPACTION_CUTOFF_DAYS = 30;
const MEMORY_DIR_NAME = "memory";

// ---------------------------------------------------------------------------
// FileBackedMemoryStore
// ---------------------------------------------------------------------------

export class FileBackedMemoryStore implements MemoryStore {
  private inMemory: InMemoryStore;
  private memoryDir: string;
  private logger: Logger;
  private fsAvailable: boolean;

  /**
   * Guards all public operations so they only run after the initial file-load
   * has finished (or failed).  This ensures reloaded data is visible before
   * the first query.
   */
  private ready: Promise<void>;

  /**
   * @param workspacePath  Root directory under which `memory/` will be created.
   */
  constructor(workspacePath: string) {
    this.memoryDir = path.join(workspacePath, MEMORY_DIR_NAME);
    this.inMemory = new InMemoryStore();
    this.logger = new Logger("FileBackedMemoryStore");
    this.fsAvailable = true;

    // Errors during initial load are swallowed so construction never throws.
    this.ready = this.loadExistingFiles().catch((err: unknown) => {
      this.logger.warn("Failed to load existing memory files, starting empty", err);
      this.fsAvailable = false;
    });
  }

  // -----------------------------------------------------------------------
  // Public API  (MemoryStore interface)
  // -----------------------------------------------------------------------

  async put(event: { scope: string; kind: string; payload: unknown; ts: Date }): Promise<void> {
    await this.ready;

    const memoryEvent: MemoryEvent = {
      id: `event-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      scope: event.scope,
      kind: event.kind,
      payload: event.payload,
      timestamp: event.ts,
    };

    // --- persist to file -------------------------------------------------
    await this.writeEvent(memoryEvent);

    // --- always keep in memory -------------------------------------------
    await this.inMemory.put(memoryEvent);
  }

  async search(
    query: { scope: string; text: string; topK?: number },
  ): Promise<Array<{ id: string; score: number; payload: unknown; timestamp: Date }>> {
    await this.ready;

    const searchQuery: SearchQuery = {
      scope: query.scope,
      text: query.text,
      ...(query.topK !== undefined && { limit: query.topK }),
    };
    return this.inMemory.search(searchQuery);
  }

  async summarize(scope: { scope: string; from?: Date; to?: Date }): Promise<string> {
    await this.ready;

    const searchQuery: SearchQuery = {
      scope: scope.scope,
    };

    if (scope.from !== undefined) {
      searchQuery.minDate = scope.from;
    }
    if (scope.to !== undefined) {
      searchQuery.maxDate = scope.to.getTime();
    }

    const results = await this.inMemory.search(searchQuery);

    if (results.length === 0) {
      return `No events found in scope "${scope.scope}".`;
    }

    // --- group by extracted kind -----------------------------------------
    const kindCounts = new Map<string, number>();
    for (const r of results) {
      const kind = r.id.split("-")[0] ?? "unknown";
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    }

    let summary = `Found ${results.length} events in scope "${scope.scope}".\n\n`;
    summary += "Event types:\n";
    for (const [kind, count] of kindCounts) {
      summary += `- ${kind}: ${count} events\n`;
    }

    // --- timeline --------------------------------------------------------
    const sorted = [...results].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
    const newest = sorted[0]!;
    const oldest = sorted[sorted.length - 1]!;
    const diffMs = newest.timestamp.getTime() - oldest.timestamp.getTime();
    const spanDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    summary += `\nDate range: ${oldest.timestamp.toLocaleDateString()} to ${newest.timestamp.toLocaleDateString()}\n`;
    summary += `Total time span: ${spanDays} day(s)`;

    return summary;
  }

  async compact(scope: { scope: string }): Promise<void> {
    await this.ready;

    // Compact the in-memory store (older than 30 days is removed)
    await this.inMemory.compact(scope.scope);

    // Clean up old JSONL files if filesystem is available
    await this.removeOldFiles();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Attempt to write a single event to the daily-rotated JSONL file.
   * Failures are caught silently; the store degrades to in-memory-only mode.
   */
  private async writeEvent(event: MemoryEvent): Promise<void> {
    if (!this.fsAvailable) {
      return;
    }
    try {
      const dateStr = toDateString(event.timestamp);
      const filePath = path.join(this.memoryDir, `${dateStr}.jsonl`);

      await fs.mkdir(this.memoryDir, { recursive: true });

      const line: PersistedEvent = {
        id: event.id,
        scope: event.scope,
        kind: event.kind,
        payload: event.payload,
        timestamp: event.timestamp.toISOString(),
      };

      await fs.appendFile(filePath, JSON.stringify(line) + "\n", "utf-8");
    } catch (err: unknown) {
      this.logger.warn("File persistence failed, falling back to in-memory only", err);
      this.fsAvailable = false;
    }
  }

  /**
   * Load every existing JSONL file under `memoryDir` into the in-memory store.
   * Malformed lines are silently skipped.
   */
  private async loadExistingFiles(): Promise<void> {
    let dirExists: boolean;
    try {
      await fs.access(this.memoryDir);
      dirExists = true;
    } catch {
      dirExists = false;
    }

    if (!dirExists) {
      return; // nothing to load
    }

    const entries = await fs.readdir(this.memoryDir);
    const jsonlFiles = entries
      .filter((e) => e.endsWith(".jsonl"))
      .sort();

    for (const file of jsonlFiles) {
      const content = await fs.readFile(path.join(this.memoryDir, file), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      for (const raw of lines) {
        try {
          const data = JSON.parse(raw) as PersistedEvent;
          const memoryEvent: MemoryEvent = {
            id: data.id,
            scope: data.scope,
            kind: data.kind,
            payload: data.payload,
            timestamp: new Date(data.timestamp),
          };
          await this.inMemory.put(memoryEvent);
        } catch {
          // skip malformed line
        }
      }
    }
  }

  /**
   * Remove JSONL files whose date-stamp is older than the compaction cutoff.
   * Failures are silently ignored (store continues in-memory).
   */
  private async removeOldFiles(): Promise<void> {
    if (!this.fsAvailable) {
      return;
    }

    try {
      let dirExists: boolean;
      try {
        await fs.access(this.memoryDir);
        dirExists = true;
      } catch {
        return;
      }

      if (!dirExists) {
        return;
      }

      const cutoff = new Date(Date.now() - COMPACTION_CUTOFF_DAYS * 24 * 60 * 60 * 1000);

      const entries = await fs.readdir(this.memoryDir);
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) {
          continue;
        }
        const datePart = entry.slice(0, -".jsonl".length);
        const fileDate = new Date(datePart);

        // Only remove if the date parsing succeeded and it's older than cutoff
        if (!isNaN(fileDate.getTime()) && fileDate < cutoff) {
          const fullPath = path.join(this.memoryDir, entry);
          await fs.rm(fullPath, { force: true });
        }
      }
    } catch (err: unknown) {
      this.logger.warn("Failed to remove old memory files during compact", err);
      this.fsAvailable = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Return the date portion of a Date object as `YYYY-MM-DD`.
 */
function toDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
