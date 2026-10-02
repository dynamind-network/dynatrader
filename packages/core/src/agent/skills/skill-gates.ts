/**
 * SkillGates
 *
 * Evaluates skill gating requirements (binaries, env vars, OS, config keys)
 * and returns pass/fail results.
 */

import { spawnSync } from 'child_process';
import type { Skill, SkillGateResult, ConfigProvider } from './skill-types';

// ---------------------------------------------------------------------------
// SkillGates
// ---------------------------------------------------------------------------

export class SkillGates {
  private configProvider?: ConfigProvider;

  constructor(configProvider?: ConfigProvider) {
    this.configProvider = configProvider;
  }

  /**
   * Override the config provider after construction.
   */
  setConfigProvider(provider: ConfigProvider): void {
    this.configProvider = provider;
  }

  // -----------------------------------------------------------------------
  // Individual gate checks
  // -----------------------------------------------------------------------

  /**
   * Check that all required binaries exist on the system PATH.
   * Uses `where.exe` on Windows, `which` elsewhere.
   */
  checkBins(requiredBins?: string[]): SkillGateResult {
    if (!requiredBins || requiredBins.length === 0) {
      return { passed: true };
    }

    const missing: string[] = [];
    const cmd = process.platform === 'win32' ? 'where' : 'which';

    for (const bin of requiredBins) {
      try {
        const result = spawnSync(cmd, [bin], {
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 5000,
        });
        if (result.status !== 0) {
          missing.push(bin);
        }
      } catch {
        missing.push(bin);
      }
    }

    if (missing.length > 0) {
      return {
        passed: false,
        reason: `Missing required binaries: ${missing.join(', ')}`,
      };
    }

    return { passed: true };
  }

  /**
   * Check that all required environment variables are set and non-empty.
   */
  checkEnv(requiredEnv?: string[]): SkillGateResult {
    if (!requiredEnv || requiredEnv.length === 0) {
      return { passed: true };
    }

    const missing: string[] = [];
    for (const envVar of requiredEnv) {
      const val = process.env[envVar];
      if (!val || val.trim().length === 0) {
        missing.push(envVar);
      }
    }

    if (missing.length > 0) {
      return {
        passed: false,
        reason: `Missing required environment variables: ${missing.join(', ')}`,
      };
    }

    return { passed: true };
  }

  /**
   * Check that the current platform is in the allowed OS list.
   * If no OS filter is set, the gate passes.
   */
  checkOs(allowedOs?: ('win32' | 'darwin' | 'linux')[]): SkillGateResult {
    if (!allowedOs || allowedOs.length === 0) {
      return { passed: true };
    }

    const current = process.platform as 'win32' | 'darwin' | 'linux';
    if (!allowedOs.includes(current)) {
      return {
        passed: false,
        reason: `Current platform "${current}" not in allowed OS list: ${allowedOs.join(', ')}`,
      };
    }

    return { passed: true };
  }

  /**
   * Check that all required config keys exist via the config provider.
   */
  checkConfig(requiredConfig?: string[]): SkillGateResult {
    if (!requiredConfig || requiredConfig.length === 0) {
      return { passed: true };
    }

    if (!this.configProvider) {
      return {
        passed: false,
        reason: 'No config provider configured; cannot check config requirements',
      };
    }

    const missing: string[] = [];
    for (const key of requiredConfig) {
      if (!this.configProvider.has(key)) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      return {
        passed: false,
        reason: `Missing required config keys: ${missing.join(', ')}`,
      };
    }

    return { passed: true };
  }

  // -----------------------------------------------------------------------
  // Evaluate all gates for a skill
  // -----------------------------------------------------------------------

  /**
   * Run every applicable gate for the given skill and return the combined
   * result. All gates must pass for the skill to be enabled.
   */
  evaluateAll(skill: Skill): SkillGateResult {
    const gates: Array<{ name: string; result: SkillGateResult }> = [];

    // 1. OS gate
    const osResult = this.checkOs(skill.metadata.os);
    gates.push({ name: 'os', result: osResult });

    // 2. Binary gate
    const binsResult = this.checkBins(skill.metadata.requires?.bins);
    gates.push({ name: 'bins', result: binsResult });

    // 3. Environment gate
    const envResult = this.checkEnv(skill.metadata.requires?.env);
    gates.push({ name: 'env', result: envResult });

    // 4. Config gate
    const configResult = this.checkConfig(skill.metadata.requires?.config);
    gates.push({ name: 'config', result: configResult });

    // Combine results
    const failures = gates.filter((g) => !g.result.passed);
    if (failures.length > 0) {
      const reasons = failures.map((f) => `[${f.name}] ${f.result.reason}`);
      return {
        passed: false,
        reason: `Skill "${skill.metadata.name}" blocked by gates: ${reasons.join('; ')}`,
      };
    }

    return { passed: true };
  }
}
