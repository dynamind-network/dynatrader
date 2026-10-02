import type { PromptSection } from './sections.js';

export interface SectionConfig {
  name: string;
  enabled: boolean;
  dynamic?: boolean;
  generator?: () => string;
}

export interface BuilderConfig {
  sections: Record<string, SectionConfig>;
}

export class PromptBuilder {
  private sections: Map<string, string> = new Map();
  private dynamicSections: Map<string, () => string> = new Map();
  private config: BuilderConfig;

  constructor(config?: Partial<BuilderConfig>) {
    this.config = {
      sections: config?.sections ?? {},
    };
  }

  addSection(name: string, content: string): this {
    this.sections.set(name, content);
    return this;
  }

  addDynamicSection(name: string, generator: () => string): this {
    this.dynamicSections.set(name, generator);
    return this;
  }

  removeSection(name: string): this {
    this.sections.delete(name);
    this.dynamicSections.delete(name);
    return this;
  }

  enableSection(name: string): this {
    const section = this.config.sections[name];
    if (section) {
      section.enabled = true;
    }
    return this;
  }

  disableSection(name: string): this {
    const section = this.config.sections[name];
    if (section) {
      section.enabled = false;
    }
    return this;
  }

  isSectionEnabled(name: string): boolean {
    const section = this.config.sections[name];
    return section ? section.enabled : true;
  }

  build(): string {
    const parts: string[] = [];

    for (const [name, content] of this.sections) {
      if (this.isSectionEnabled(name)) {
        parts.push(content);
      }
    }

    for (const [name, generator] of this.dynamicSections) {
      if (this.isSectionEnabled(name)) {
        parts.push(generator());
      }
    }

    return parts.join('\n\n');
  }

  buildWithBoundary(): { static: string; dynamic: string } {
    const staticParts: string[] = [];
    const dynamicParts: string[] = [];

    for (const [name, content] of this.sections) {
      if (this.isSectionEnabled(name)) {
        staticParts.push(content);
      }
    }

    for (const [name, generator] of this.dynamicSections) {
      if (this.isSectionEnabled(name)) {
        dynamicParts.push(generator());
      }
    }

    return {
      static: staticParts.join('\n\n'),
      dynamic: dynamicParts.join('\n\n'),
    };
  }

  getSection(name: string): string | undefined {
    return this.sections.get(name);
  }

  getAllSections(): string[] {
    return Array.from(this.sections.keys());
  }

  clear(): this {
    this.sections.clear();
    this.dynamicSections.clear();
    return this;
  }
}

export function createBuilder(config?: Partial<BuilderConfig>): PromptBuilder {
  return new PromptBuilder(config);
}

export function createDefaultBuilder(): PromptBuilder {
  const builder = new PromptBuilder({
    sections: {
      intro: { name: 'intro', enabled: true },
      tone: { name: 'tone', enabled: true },
      format: { name: 'format', enabled: true },
      trading_rules: { name: 'trading_rules', enabled: false },
      risk_management: { name: 'risk_management', enabled: false },
      session: { name: 'session', enabled: false, dynamic: true },
      market_context: { name: 'market_context', enabled: false, dynamic: true },
    },
  });

  builder
    .addSection(
      'intro',
      'You are DynaMind, an AI-powered general-purpose coding and agent assistant. You can handle software development, analysis, research, planning, automation, and domain-specific workflows when the necessary tools or context are available. Treat code/script creation requests as coding tasks. Write the requested code directly. Only search or inspect existing files when the task depends on codebase context.'
    )
    .addSection('tone', 'Be concise, accurate, and action-oriented.')
    .addSection('format', 'Use structured output and include sources.');

  return builder;
}

