/**
 * SkillFactory
 *
 * Builds reusable skill artifacts from accumulated learnings and completed
 * work. Strategy-derived skills are written deterministically under the
 * active workspace skill tree.
 */

import type { SkillManifest } from "@dyna/contracts";
import type { MarketConditions } from "./types";
import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface CompletedTask {
  title: string;
  description?: string;
  outcome: string;
  steps?: string[];
  evidence?: string[];
  tags?: string[];
  successful?: boolean;
}

export interface ReusableSkill {
  id: string;
  name: string;
  description: string;
  instructions: string[];
  triggers: string[];
  evidence: string[];
  sourceTask: string;
  createdAt: string;
  updatedAt: string;
  sourceKind?: "task" | "strategy";
  approvalState?: "approved";
  strategy?: SkillManifest;
}

export interface SkillFactoryOptions {
  workspacePath?: string;
  defaultVenue?: string;
  defaultRisk?: {
    maxPositionNotional?: number;
    maxDailyLoss?: number;
    maxOpenOrders?: number;
  };
}

export interface StrategySkillArtifact {
  skill: ReusableSkill;
  directory: string;
  path: string;
  approvalState: "approved";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CONFIDENCE_FOR_CREATION = 0.4;
const MIN_EVIDENCE_FOR_CREATION = 2;
const ACTIVE_SKILLS_DIR = "skills";
const ACTIVE_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// SkillFactory
// ---------------------------------------------------------------------------

export class SkillFactory {
  private readonly workspacePath: string;
  private readonly skillsDir: string;
  private readonly defaultVenue: string;
  private readonly defaultRisk?: SkillFactoryOptions["defaultRisk"];

  constructor(options: string | SkillFactoryOptions = {}) {
    this.workspacePath = typeof options === "string" ? options : options.workspacePath ?? process.cwd();
    this.skillsDir = path.join(this.workspacePath, ACTIVE_SKILLS_DIR);
    this.defaultVenue = typeof options === "string" ? "" : options.defaultVenue?.trim() ?? "";
    this.defaultRisk = typeof options === "string" ? undefined : options.defaultRisk;
  }

  /** Extract and persist a reusable, domain-independent skill from a completed task. */
  async createSkillFromTask(task: CompletedTask): Promise<ReusableSkill | null> {
    if (task.successful === false || !task.title.trim() || !task.outcome.trim()) return null;

    const name = slugify(task.title);
    const now = new Date().toISOString();
    const skill: ReusableSkill = {
      id: `skill-${name}`,
      name,
      description: task.description?.trim() || task.outcome.trim(),
      instructions: task.steps?.filter(Boolean) ?? [task.outcome.trim()],
      triggers: unique([...(task.tags ?? []), ...keywords(task.title)]),
      evidence: task.evidence?.filter(Boolean) ?? [],
      sourceTask: task.title.trim(),
      createdAt: now,
      updatedAt: now,
      sourceKind: "task",
      approvalState: "approved",
    };

    await this.writeSkillArtifact({
      skill,
      directory: path.join(this.skillsDir, name),
      approvalState: "approved",
      category: "utility",
      status: "validated",
      allowedModes: ["research", "backtest", "paper"],
      riskLevel: "low",
      reviewHumanRequired: false,
      allowOrderExecution: false,
      tags: skill.triggers,
      confidence: 0.5,
    });

    return skill;
  }

  /**
   * Create a new reusable trading skill directly in the active skill tree.
   */
  async proposeStrategy(
    strategy: SkillManifest,
    conditions: MarketConditions,
  ): Promise<StrategySkillArtifact | null> {
    const artifact = this.buildStrategySkillArtifact(strategy, conditions);
    if (!artifact) {
      return null;
    }

    await this.writeSkillArtifact({
      skill: artifact.skill,
      directory: path.join(this.skillsDir, artifact.directory),
      approvalState: "approved",
      category: "strategy",
      status: "validated",
      allowedModes: ["research", "backtest", "paper"],
      riskLevel: "medium",
      reviewHumanRequired: false,
      allowOrderExecution: false,
      tags: artifact.skill.triggers,
      confidence: 0.5,
      strategy,
      conditions,
    });

    return artifact;
  }

  async approveStrategySkill(skillName: string): Promise<StrategySkillArtifact | null> {
    const directoryName = slugify(skillName);
    const activePath = path.join(this.skillsDir, directoryName);
    const proposal = await this.readReusableSkillArtifact(activePath);
    if (!proposal) {
      return null;
    }

    const approvedSkill: ReusableSkill = {
      ...proposal,
      updatedAt: new Date().toISOString(),
      approvalState: "approved",
    };

    await this.writeSkillArtifact({
      skill: approvedSkill,
      directory: activePath,
      approvalState: "approved",
      category: "strategy",
      status: "validated",
      allowedModes: ["research", "backtest", "paper"],
      riskLevel: "medium",
      reviewHumanRequired: false,
      allowOrderExecution: false,
      tags: approvedSkill.triggers,
      confidence: this.estimateProposalConfidenceFromSkill(approvedSkill),
      strategy: approvedSkill.strategy,
      conditions: this.extractConditionsFromSkill(approvedSkill),
    });

    return {
      skill: approvedSkill,
      directory: directoryName,
      path: path.join(this.skillsDir, directoryName),
      approvalState: "approved",
    };
  }

  async listSkills(): Promise<ReusableSkill[]> {
    return this.listSkillDirectory(this.skillsDir);
  }

  async getSkill(name: string): Promise<ReusableSkill | null> {
    try {
      const raw = await fs.readFile(path.join(this.skillsDir, slugify(name), "skill.json"), "utf8");
      return JSON.parse(raw) as ReusableSkill;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async findSkills(query: string): Promise<ReusableSkill[]> {
    const terms = keywords(query);
    return (await this.listSkills()).filter((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.triggers.join(" ")}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  }

  /**
   * Create a new SkillManifest from market conditions.
   *
   * Returns null when:
   * - No venue is configured
   * - Risk parameters are missing
   */
  createStrategy(
    conditions: MarketConditions,
    symbol: string,
  ): SkillManifest | null {
    const entryConfig = this.buildEntryConfig(conditions);
    const exitConfig = this.buildExitConfig();
    const riskConfig = this.buildRiskConfig();
    const venue = this.defaultVenue.trim();

    if (!venue) {
      return null;
    }

    const maxPositionNotional =
      (riskConfig.maxPositionNotional as number | undefined) ??
      this.defaultRisk?.maxPositionNotional;
    const maxDailyLoss =
      (riskConfig.maxDailyLoss as number | undefined) ??
      this.defaultRisk?.maxDailyLoss;
    const maxOpenOrders =
      (riskConfig.maxOpenOrders as number | undefined) ??
      this.defaultRisk?.maxOpenOrders;

    if (
      typeof maxPositionNotional !== "number" ||
      typeof maxDailyLoss !== "number" ||
      typeof maxOpenOrders !== "number"
    ) {
      return null;
    }

    return {
      id: `skill-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      venue,
      symbol,
      entry: entryConfig,
      exits: exitConfig,
      sizing: {
        method: "kelly",
        kellyFraction: 0.25,
        maxPositionPct: 0.1,
      },
      risk: {
        maxPositionNotional,
        maxDailyLoss,
        maxOpenOrders,
      },
      executionMode: "paper",
    };
  }

  /**
   * Build entry configuration with default values.
   */
  private buildEntryConfig(
    conditions: MarketConditions,
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {
      type: "momentum",
      enabled: true,
      rsiThreshold: 30,
      regime: conditions.regime,
      volatility: conditions.volatility,
    };

    return config;
  }

  /**
   * Build exit configuration with default values.
   */
  private buildExitConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {
      riskReward: 2.0,
      stopLoss: 0.02,
      takeProfit: 0.04,
    };

    return config;
  }

  /**
   * Build risk configuration with default values.
   */
  private buildRiskConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {
      maxPositionNotional: 5000,
      maxDailyLoss: 500,
      maxOpenOrders: 3,
    };

    return config;
  }

  private buildStrategySkillArtifact(
    strategy: SkillManifest,
    conditions: MarketConditions,
  ): StrategySkillArtifact | null {
    const name = this.buildStrategySkillName(strategy.symbol, strategy.venue, conditions.regime);
    const now = new Date().toISOString();
    const skill: ReusableSkill = {
      id: `skill-${name}`,
      name,
      description: `Reusable strategy skill for ${strategy.symbol} on ${strategy.venue} in ${conditions.regime} markets`,
      instructions: [
        `Use the learned strategy for ${strategy.symbol}.`,
        `Adapt to ${conditions.regime} conditions with ${conditions.volatility} volatility.`,
        "Preserve the recorded risk rules and exit discipline.",
      ],
      triggers: unique([
        strategy.symbol,
        strategy.venue,
        conditions.regime,
        conditions.trend,
        conditions.volume,
      ]),
      evidence: [],
      sourceTask: `Learned strategy from ${strategy.symbol} on ${strategy.venue}`,
      createdAt: now,
      updatedAt: now,
      sourceKind: "strategy",
      approvalState: "approved",
      strategy,
    };

    return {
      skill,
      directory: name,
      path: path.join(this.skillsDir, name),
      approvalState: "approved",
    };
  }

  private buildStrategySkillName(symbol: string, venue: string, regime: string): string {
    return slugify(`strategy ${symbol} ${venue} ${regime}`);
  }

  private async listSkillDirectory(dirPath: string): Promise<ReusableSkill[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const skills = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => this.readReusableSkillArtifact(path.join(dirPath, entry.name))),
      );
      return skills.filter((skill): skill is ReusableSkill => skill !== null);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  private async readReusableSkillArtifact(dirPath: string): Promise<ReusableSkill | null> {
    try {
      const raw = await fs.readFile(path.join(dirPath, "skill.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed.name || !parsed.description) {
        return null;
      }

      const skill = parsed.strategy && typeof parsed.strategy === "object"
        ? (parsed.strategy as SkillManifest)
        : undefined;

      return {
        id: typeof parsed.id === "string" ? parsed.id : `skill-${slugify(String(parsed.name))}`,
        name: String(parsed.name),
        description: String(parsed.description),
        instructions: await this.readInstructions(dirPath),
        triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String) : [],
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
        sourceTask: typeof parsed.sourceTask === "string" ? parsed.sourceTask : String(parsed.description),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        sourceKind: parsed.sourceKind === "strategy" ? "strategy" : "task",
        approvalState: "approved",
        strategy: skill,
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  private async readInstructions(dirPath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(path.join(dirPath, "SKILL.md"), "utf8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async writeSkillArtifact(options: {
    skill: ReusableSkill;
    directory: string;
    approvalState: "approved";
    category: "task" | "strategy" | "utility" | "analysis" | "risk" | "research";
    status: "draft" | "validated";
    allowedModes: Array<"research" | "backtest" | "paper">;
    riskLevel: "low" | "medium";
    reviewHumanRequired: boolean;
    allowOrderExecution: boolean;
    tags: string[];
    confidence: number;
    strategy?: SkillManifest;
    conditions?: MarketConditions;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { skill, directory } = options;
    const skillJson = {
      id: skill.id,
      name: skill.name,
      version: ACTIVE_VERSION,
      description: skill.description,
      category: options.category,
      status: options.status,
      allowed_modes: options.allowedModes,
      permissions: {
        allow: options.category === "strategy"
          ? ["read_memory", "write_memory", "fetch_market_data"]
          : ["read_memory", "write_memory"],
        deny: ["execute_order"],
      },
      tools_required: options.category === "strategy"
        ? ["market_data", "memory_search"]
        : [],
      risk_level: options.riskLevel,
      review: {
        humanRequired: options.reviewHumanRequired,
        testsRequired: options.category === "strategy",
        signatureRequired: false,
      },
      security: {
        allowNetwork: false,
        allowFilesystem: false,
        allowCredentials: false,
        allowOrderExecution: options.allowOrderExecution,
      },
      tags: unique([
        ...options.tags,
        ...(options.strategy ? [options.strategy.symbol, options.strategy.venue] : []),
        ...(options.conditions ? [options.conditions.regime, options.conditions.trend, options.conditions.volume] : []),
      ]),
      confidence: options.confidence,
      sourceKind: skill.sourceKind ?? "task",
      sourceTask: skill.sourceTask,
      approvalState: options.approvalState,
      createdAt: skill.createdAt ?? now,
      updatedAt: now,
      triggers: skill.triggers,
      evidence: skill.evidence,
      strategy: options.strategy,
      symbol: options.strategy?.symbol,
      venue: options.strategy?.venue,
      regime: options.conditions?.regime,
      volatility: options.conditions?.volatility,
    };

    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), renderSkill(skill), "utf8");
    writeFileSync(path.join(directory, "skill.json"), JSON.stringify(skillJson, null, 2) + "\n", "utf8");
  }

  private estimateProposalConfidenceFromSkill(skill: ReusableSkill): number {
    if (skill.evidence.length === 0) return 0.5;
    return Math.max(0.1, Math.min(0.99, Math.round((0.5 + Math.min(skill.evidence.length, 10) * 0.04) * 100) / 100));
  }

  private extractConditionsFromSkill(skill: ReusableSkill): MarketConditions {
    const regime = skill.triggers.find((trigger) =>
      ["trending", "ranging", "volatile", "calm"].includes(trigger),
    ) ?? "trending";
    const trend = skill.triggers.find((trigger) =>
      ["bullish", "bearish", "neutral"].includes(trigger),
    ) ?? "neutral";
    const volume = skill.triggers.find((trigger) =>
      ["high", "normal", "low"].includes(trigger),
    ) ?? "normal";

    return {
      regime: regime as MarketConditions["regime"],
      trend: trend as MarketConditions["trend"],
      volume: volume as MarketConditions["volume"],
      volatility: skill.strategy ? 0.02 : 0.03,
    };
  }
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "task-skill";
}

function keywords(value: string): string[] {
  return unique(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

function renderSkill(skill: ReusableSkill): string {
  const steps = skill.instructions.map((step, index) => `${index + 1}. ${step}`).join("\n");
  const evidence = skill.evidence.length
    ? `\n## Evidence\n\n${skill.evidence.map((item) => `- ${item}`).join("\n")}\n`
    : "";
  const strategy = skill.strategy
    ? `\n## Strategy\n\n\`\`\`json\n${JSON.stringify(skill.strategy, null, 2)}\n\`\`\`\n`
    : "";
  const approval = skill.approvalState ? `\n## Approval\n\n- State: ${skill.approvalState}\n` : "";
  return `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\n/g, " ")}\nsourceKind: ${skill.sourceKind ?? "task"}\n---\n\n# ${skill.sourceTask}\n\n## Instructions\n\n${steps}\n${approval}${strategy}${evidence}`;
}
