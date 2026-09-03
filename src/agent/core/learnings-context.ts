/**
 * Build a learnings context string to inject into the agent prompt.
 *
 * Extracted from AgentCore to keep agent-core.ts focused on orchestration.
 */

import type { StrategySource } from "@dyna/contracts";
import type { MemoryStoreImpl } from "@dyna/memory-core";
import type { MarketConditions } from "./types";
import type { CrossSessionRecall } from "./cross-session-recall";
import type { SkillLoader } from "../skills/skill-loader";
import { SkillInjector, SkillGates } from "../skills";

interface LearningsContextDeps {
  memory: MemoryStoreImpl;
  crossSessionRecall: CrossSessionRecall | null;
  skillLoader?: SkillLoader;
}

export async function buildLearningsContext(
  deps: LearningsContextDeps,
  source: StrategySource,
): Promise<string> {
  try {
    const symbol = typeof source.params?.symbol === "string"
      ? (source.params.symbol as string).trim()
      : "";
    const query = symbol || source.kind || source.body.slice(0, 80).trim() || "strategy";

    const parts: string[] = [];

    // Add cross-session recall search
    if (deps.crossSessionRecall) {
      try {
        const recallResults = await deps.crossSessionRecall.search(query);
        if (recallResults.length > 0) {
          const recallSection = recallResults
            .slice(0, 3)
            .map(r => `[Session ${r.sessionId}] (score: ${(r.score * 100).toFixed(0)}%) ${r.text}`)
            .join('\n');
          parts.push(`--- Past Session Patterns ---\n${recallSection}`);
        }
      } catch (err) {
        console.warn('Cross-session recall search failed', err);
      }
    }

    // Retrieve existing skills/strategies from memory
    if (deps.memory) {
      try {
        const skillResults = await deps.memory.search({
          scope: 'agent_memory',
          text: `skill strategy ${query}`,
          topK: 5,
        });
        const skills = skillResults.filter(r => {
          const p = r.payload as Record<string, unknown>;
          return p?.type === 'skill_created' || p?.kind === 'strategy';
        });
        if (skills.length > 0) {
          const skillSection = skills
            .slice(0, 3)
            .map(s => {
              const p = s.payload as Record<string, unknown>;
              return `[Skill] ${p?.description || p?.name || 'Unnamed'} (confidence: ${((s.score || 0) * 100).toFixed(0)}%)`;
            })
            .join('\n');
          parts.push(`--- Existing Strategies ---\n${skillSection}`);
        }
      } catch (err) {
        console.warn('Skill retrieval failed', err);
      }
    }

    // Inject enabled skills as XML context
    if (deps.skillLoader) {
      try {
        const allSkills = deps.skillLoader.getAllSkills();
        if (allSkills.length > 0) {
          const skillGates = new SkillGates();
          const enabledSkills = deps.skillLoader.getEnabledSkills(skillGates);
          if (enabledSkills.length > 0) {
            const skillInjector = new SkillInjector();
            const skillContext = skillInjector.buildSkillContext(enabledSkills);
            if (skillContext) {
              parts.push(`--- Available Skills ---\n${skillContext}`);
            }
          }
        }
      } catch (err) {
        console.warn('Skill injection failed', err);
      }
    }

    return parts.filter(p => p.length > 0).join("\n\n");
  } catch {
    return "";
  }
}
