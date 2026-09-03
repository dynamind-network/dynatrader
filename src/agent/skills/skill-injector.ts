/**
 * SkillInjector
 *
 * Builds a compact XML block from enabled skills and injects it into
 * system prompts.
 *
 * Format:
 *   <available_skills>
 *     <skill name="X" type="Y">
 *       <description>...</description>
 *       <instructions>...</instructions>
 *     </skill>
 *   </available_skills>
 */

import type { Skill } from './skill-types';

// ---------------------------------------------------------------------------
// SkillInjector
// ---------------------------------------------------------------------------

export class SkillInjector {
  /**
   * Build a compact XML context block from a list of skills.
   * Skills are sorted by precedence (highest priority first) then by name.
   *
   * @param skills - Skills to include in the context block.
   * @returns XML string suitable for injection into a system prompt.
   */
  buildSkillContext(skills: Skill[]): string {
    if (skills.length === 0) {
      return '';
    }

    // Sort: lower precedence number = higher priority, then alphabetical by name.
    const sorted = [...skills].sort((a, b) => {
      if (a.precedence !== b.precedence) return a.precedence - b.precedence;
      return a.metadata.name.localeCompare(b.metadata.name);
    });

    const parts: string[] = ['<available_skills>'];

    for (const skill of sorted) {
      const name = this.escapeXml(skill.metadata.name);
      const type = this.escapeXml(skill.metadata.type);
      const description = this.escapeXml(skill.metadata.description);
      const instructions = this.escapeXml(skill.instructions);

      parts.push(
        `  <skill name="${name}" type="${type}">`,
        `    <description>${description}</description>`,
        `    <instructions>`,
        `      ${instructions}`,
        `    </instructions>`,
        `  </skill>`,
      );
    }

    parts.push('</available_skills>');

    return parts.join('\n');
  }

  /**
   * Inject a skill context XML block into a system prompt.
   * Appends the block at the end of the prompt, separated by a blank line.
   *
   * @param prompt - The original system prompt.
   * @param skillContext - The XML skill context block (from buildSkillContext).
   * @returns The prompt with the skill context appended.
   */
  injectIntoPrompt(prompt: string, skillContext: string): string {
    if (!skillContext) {
      return prompt;
    }

    // If the prompt already has an <available_skills> block, replace it.
    const regex = /<available_skills>[\s\S]*?<\/available_skills>/;
    if (regex.test(prompt)) {
      return prompt.replace(regex, skillContext);
    }

    // Otherwise append.
    return `${prompt}\n\n${skillContext}`;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Escape XML special characters to prevent injection issues.
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}