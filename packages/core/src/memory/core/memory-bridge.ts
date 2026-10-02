/**
 * Memory Bridge
 *
 * Synchronizes MEMORY.md (hot memory) with SQLite (cold storage).
 * - Parses MEMORY.md sections into structured entries
 * - Syncs to SQLite for FTS5 searchability
 * - Can regenerate MEMORY.md from SQLite entries
 *
 * This bridge ensures the agent's curated MEMORY.md stays in sync
 * with the searchable SQLite backend.
 */

import type { MemoryStoreBackend, MemoryEvent } from '@dyna/memory-core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export interface MemoryBridgeConfig {
  /** Path to MEMORY.md file */
  memoryMdPath: string;
  /** Scope to use for MEMORY.md entries in SQLite */
  scope?: string;
  /** Auto-sync on read/write operations */
  autoSync?: boolean;
}

export interface ParsedMemorySection {
  heading: string;
  level: number;
  content: string;
  lineStart: number;
  lineEnd: number;
}

export interface SyncResult {
  sectionsParsed: number;
  entriesSynced: number;
  entriesUpdated: number;
  entriesRemoved: number;
  timestamp: Date;
}

/**
 * MemoryBridge synchronizes MEMORY.md with SQLite storage.
 *
 * Flow:
 * 1. parseMemoryMd() - Reads MEMORY.md and parses into sections
 * 2. syncToSqlite() - Writes sections as memory events to SQLite
 * 3. generateMemoryMd() - Regenerates MEMORY.md from SQLite events
 */
export class MemoryBridge {
  private config: Required<MemoryBridgeConfig>;
  private lastSyncResult?: SyncResult;

  constructor(
    private backend: MemoryStoreBackend,
    config: MemoryBridgeConfig,
  ) {
    this.config = {
      scope: 'memory_md',
      autoSync: true,
      ...config,
    };
  }

  /**
   * Read and parse MEMORY.md into structured sections.
   */
  async parseMemoryMd(): Promise<ParsedMemorySection[]> {
    try {
      const content = await fs.readFile(this.config.memoryMdPath, 'utf-8');
      return this.parseMarkdownSections(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Parse markdown content into sections based on headings.
   */
  private parseMarkdownSections(content: string): ParsedMemorySection[] {
    const lines = content.split('\n');
    const sections: ParsedMemorySection[] = [];
    let currentSection: ParsedMemorySection | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

      if (headingMatch) {
        // Save previous section
        if (currentSection) {
          currentSection.lineEnd = i - 1;
          sections.push(currentSection);
        }

        // Start new section
        currentSection = {
          heading: headingMatch[2].trim(),
          level: headingMatch[1].length,
          content: '',
          lineStart: i,
          lineEnd: lines.length - 1,
        };
      } else if (currentSection) {
        currentSection.content += (currentSection.content ? '\n' : '') + line;
      }
    }

    // Save last section
    if (currentSection) {
      sections.push(currentSection);
    }

    return sections;
  }

  /**
   * Sync MEMORY.md content to SQLite.
   * Creates memory events for each section.
   */
  async syncToSqlite(): Promise<SyncResult> {
    const sections = await this.parseMemoryMd();
    const result: SyncResult = {
      sectionsParsed: sections.length,
      entriesSynced: 0,
      entriesUpdated: 0,
      entriesRemoved: 0,
      timestamp: new Date(),
    };

    // Get existing MEMORY.md entries from SQLite
    const existingEntries = await this.backend.search({
      scope: this.config.scope,
      kind: 'memory_md_section',
      limit: 1000,
    });

    const existingMap = new Map<string, MemoryEvent>();
    for (const entry of existingEntries) {
      const event = await this.backend.get(entry.id);
      if (event) {
        existingMap.set(entry.id, event);
      }
    }

    // Track which sections we've synced
    const syncedIds = new Set<string>();

    for (const section of sections) {
      const sectionId = this.generateSectionId(section);

      // Check if this section already exists
      const existing = Array.from(existingMap.values()).find(
        (e) => (e.payload as Record<string, unknown>)?.sectionId === sectionId,
      );

      if (existing) {
        // Update existing entry if content changed
        const existingContent = (existing.payload as Record<string, unknown>)?.content as string;
        if (existingContent !== section.content) {
          const updatedEvent: MemoryEvent = {
            ...existing,
            payload: {
              ...existing.payload as Record<string, unknown>,
              content: section.content,
              heading: section.heading,
              level: section.level,
              updatedAt: new Date().toISOString(),
            },
            timestamp: new Date(),
          };
          await this.backend.put(updatedEvent);
          result.entriesUpdated++;
        }
        syncedIds.add(existing.id);
      } else {
        // Create new entry
        const event: MemoryEvent = {
          id: `memmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          scope: this.config.scope,
          kind: 'memory_md_section',
          payload: {
            sectionId,
            heading: section.heading,
            level: section.level,
            content: section.content,
            lineStart: section.lineStart,
            lineEnd: section.lineEnd,
            source: 'memory_md',
          },
          timestamp: new Date(),
          metadata: {
            addedBy: 'memory_bridge',
            source: 'memory_md_sync',
          },
        };
        await this.backend.put(event);
        result.entriesSynced++;
        syncedIds.add(event.id);
      }
    }

    // Mark sections that no longer exist in MEMORY.md as deleted
    for (const [id, event] of existingMap) {
      if (!syncedIds.has(id)) {
        const deletedEvent: MemoryEvent = {
          ...event,
          kind: 'memory_md_section:deleted',
          payload: {
            ...event.payload as Record<string, unknown>,
            deletedAt: new Date().toISOString(),
          },
          timestamp: new Date(),
        };
        await this.backend.put(deletedEvent);
        result.entriesRemoved++;
      }
    }

    this.lastSyncResult = result;
    return result;
  }

  /**
   * Generate a deterministic section ID from section content.
   * Uses SHA-256 for collision resistance.
   */
  private generateSectionId(section: ParsedMemorySection): string {
    const content = `${section.heading}:${section.level}:${section.content}`;
    const hash = createHash('sha256').update(content).digest('hex').substring(0, 16);
    return `section-${hash}`;
  }

  /**
   * Regenerate MEMORY.md from SQLite entries.
   * Useful for restoring MEMORY.md from cold storage.
   */
  async generateMemoryMd(): Promise<string> {
    const entries = await this.backend.search({
      scope: this.config.scope,
      kind: 'memory_md_section',
      limit: 1000,
    });

    if (entries.length === 0) {
      return '# MEMORY.md - Hot Memory\n\nThis file is always loaded into context. Keep it concise and current.\n';
    }

    // Get full events and sort by line number
    const events: Array<{ event: MemoryEvent; lineStart: number }> = [];
    for (const entry of entries) {
      const event = await this.backend.get(entry.id);
      if (event && !event.kind.includes(':deleted')) {
        events.push({
          event,
          lineStart: ((event.payload as Record<string, unknown>)?.lineStart as number) ?? 0,
        });
      }
    }

    events.sort((a, b) => a.lineStart - b.lineStart);

    // Build markdown content
    const lines: string[] = [];
    for (const { event } of events) {
      const payload = event.payload as Record<string, unknown>;
      const level = payload.level as number;
      const heading = payload.heading as string;
      const content = payload.content as string;

      lines.push('#'.repeat(level) + ' ' + heading);
      if (content) {
        lines.push(content);
      }
      lines.push(''); // Empty line between sections
    }

    return lines.join('\n');
  }

  /**
   * Write updated section content back to MEMORY.md.
   */
  async updateSection(heading: string, newContent: string): Promise<boolean> {
    try {
      const content = await fs.readFile(this.config.memoryMdPath, 'utf-8');
      const lines = content.split('\n');

      let inSection = false;
      let sectionLevel = 0;
      let startLine = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

        if (headingMatch) {
          if (inSection) {
            // End of section - replace content
            const newLines = [
              ...lines.slice(0, startLine + 1),
              newContent,
              ...lines.slice(i),
            ];
            await fs.writeFile(this.config.memoryMdPath, newLines.join('\n'), 'utf-8');
            return true;
          }

          if (headingMatch[2].trim() === heading) {
            inSection = true;
            sectionLevel = headingMatch[1].length;
            startLine = i;
          }
        }
      }

      // If we're still in section at end of file
      if (inSection) {
        const newLines = [
          ...lines.slice(0, startLine + 1),
          newContent,
        ];
        await fs.writeFile(this.config.memoryMdPath, newLines.join('\n'), 'utf-8');
        return true;
      }

      return false; // Section not found
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Create file with new section
        const content = `# MEMORY.md - Hot Memory\n\n## ${heading}\n${newContent}\n`;
        await fs.writeFile(this.config.memoryMdPath, content, 'utf-8');
        return true;
      }
      throw err;
    }
  }

  /**
   * Get the last sync result.
   */
  getLastSyncResult(): SyncResult | undefined {
    return this.lastSyncResult;
  }

  /**
   * Check if MEMORY.md exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.config.memoryMdPath);
      return true;
    } catch {
      return false;
    }
  }
}
