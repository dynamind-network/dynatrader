export interface TemplateVariables {
  SKILL_DIR?: string;
  COMMAND_DIR?: string;
  PROJECT_ROOT?: string;
  WORKING_DIR?: string;
  SESSION_ID?: string;
  QUERY?: string;
  DATE?: string;
  TIMESTAMP?: string;
  [key: string]: string | undefined;
}

const VARIABLE_REGEX = /\$\{([^}]+)\}/g;

export function resolveTemplate(content: string, variables: TemplateVariables): string {
  return content.replace(VARIABLE_REGEX, (_match, varName: string) => {
    const value = variables[varName];
    if (value !== undefined) {
      return value;
    }
    return _match;
  });
}

export function extractTemplateVariables(content: string): string[] {
  const matches = [...content.matchAll(VARIABLE_REGEX)];
  const vars = new Set<string>();
  for (const match of matches) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}

export function buildDefaultVariables(overrides?: Partial<TemplateVariables>): TemplateVariables {
  const now = new Date();
  return {
    DATE: now.toISOString().split('T')[0],
    TIMESTAMP: now.toISOString(),
    ...overrides,
  };
}
