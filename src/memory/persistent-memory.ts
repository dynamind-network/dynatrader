import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PersistentMemoryEntry {
  id: string;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** Simple inspectable file memory for cross-session task knowledge. */
export class PersistentMemory {
  private readonly directory: string;

  constructor(workspacePath: string = process.cwd()) {
    this.directory = path.join(workspacePath, ".dynamind", "memory");
  }

  async remember(input: Omit<PersistentMemoryEntry, "id" | "createdAt">): Promise<PersistentMemoryEntry> {
    const createdAt = new Date().toISOString();
    const entry = { ...input, id: `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt };
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${createdAt.slice(0, 10)}.jsonl`);
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  async recall(query = "", limit = 20): Promise<PersistentMemoryEntry[]> {
    try {
      const files = (await fs.readdir(this.directory)).filter((file) => file.endsWith(".jsonl")).sort().reverse();
      const entries: PersistentMemoryEntry[] = [];
      for (const file of files) {
        const lines = (await fs.readFile(path.join(this.directory, file), "utf8")).split(/\r?\n/).filter(Boolean);
        for (const line of lines.reverse()) {
          try {
            const entry = JSON.parse(line) as PersistentMemoryEntry;
            const haystack = `${entry.kind} ${entry.content} ${JSON.stringify(entry.metadata ?? {})}`.toLowerCase();
            if (!query || haystack.includes(query.toLowerCase())) entries.push(entry);
            if (entries.length >= limit) return entries;
          } catch { /* tolerate partial or malformed lines */ }
        }
      }
      return entries;
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
}
