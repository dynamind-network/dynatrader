interface PromptSectionCache {
  sections: Map<string, { value: string | null; timestamp: number }>;
  version: number;
}

const SECTION_CACHE_TTL_MS = 5 * 60 * 1000;

export interface SystemPromptSection {
  name: string;
  compute: () => string | null | Promise<string | null>;
  cacheBreak: boolean;
}

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__DYNAMIND_DYNAMIC_BOUNDARY__";

export function cachedSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
): SystemPromptSection {
  return { name, compute, cacheBreak: false };
}

export function uncachedSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
): SystemPromptSection {
  return { name, compute, cacheBreak: true };
}

export class PromptSectionManager {
  private cache: PromptSectionCache = { sections: new Map(), version: 0 };

  async resolveSections(
    sections: SystemPromptSection[],
  ): Promise<(string | null)[]> {
    return Promise.all(
      sections.map(async (section) => {
        if (!section.cacheBreak) {
          const cached = this.cache.sections.get(section.name);
          if (cached && Date.now() - cached.timestamp < SECTION_CACHE_TTL_MS) {
            return cached.value;
          }
        }

        const value = await section.compute();
        if (!section.cacheBreak) {
          this.cache.sections.set(section.name, {
            value,
            timestamp: Date.now(),
          });
        }
        return value;
      }),
    );
  }

  invalidate(name?: string): void {
    if (name) {
      this.cache.sections.delete(name);
    } else {
      this.cache.sections.clear();
    }
    this.cache.version++;
  }

  getCacheStats(): { cached: number; total: number } {
    const now = Date.now();
    let validCount = 0;
    for (const entry of this.cache.sections.values()) {
      if (now - entry.timestamp < SECTION_CACHE_TTL_MS) validCount++;
    }
    return { cached: validCount, total: this.cache.sections.size };
  }
}
