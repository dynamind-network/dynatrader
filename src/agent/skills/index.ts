/**
 * @dyna/skills
 *
 * Skill system for DynaTrader.
 * Provides SKILL.md file loading with YAML frontmatter, gating,
 * precedence-based loading, prompt injection, and a workshop proposal queue.
 */

export { SkillLoader } from './skill-loader';
export { SkillGates } from './skill-gates';
export { SkillInjector } from './skill-injector';
export { SkillWorkshop } from './skill-workshop';
export { SkillImporter } from './skill-importer';

export type {
  SkillMetadata,
  Skill,
  SkillGateResult,
  ConfigProvider,
  PrecedenceLevel,
  ProposalStatus,
  SkillProposal,
} from './skill-types';

export { PRECEDENCE_ORDER } from './skill-types';