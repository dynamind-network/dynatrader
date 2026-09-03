import fs from 'fs/promises';
import path from 'path';

const CORE_PROMPT_FILES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md'];

async function readOptionalFile(workspacePath: string, filename: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspacePath, filename), 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export type PersonaName = 'trader' | 'coder' | 'personal';

/**
 * Build a workspace-authored system prompt from the canonical runtime files.
 * The runtime should prefer this over any baked-in persona text.
 *
 * If a persona is specified, load `personas/{persona}.md` as the primary
 * identity and prepend it to the workspace instructions.
 */
export async function loadWorkspaceAgentPrompt(
  workspacePath: string,
  persona?: PersonaName | null,
): Promise<string> {
  const sections: string[] = [];

  // If persona is set, load the persona file as the primary identity
  if (persona) {
    const personaContent = await readOptionalFile(
      workspacePath,
      path.join('personas', `${persona}.md`),
    );
    if (personaContent?.trim()) {
      sections.push(`## PERSONA: ${persona}\n${personaContent.trim()}`);
    }
  }

  // Always load the core prompt files (SOUL.md, IDENTITY.md, etc.)
  for (const filename of CORE_PROMPT_FILES) {
    const content = await readOptionalFile(workspacePath, filename);
    if (!content?.trim()) continue;
    sections.push(`## ${filename}\n${content.trim()}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return [
    'Workspace instructions define the agent identity, steps, and constraints.',
    'Follow the workspace files below before any default behavior.',
    'Prefer progressive disclosure: only read optional files when they matter.',
    '',
    ...sections,
  ].join('\n');
}
