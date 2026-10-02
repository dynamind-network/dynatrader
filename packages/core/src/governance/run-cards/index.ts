import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { AuditTrail } from '@dyna/audit';
import { Logger } from '@dyna/audit';

export interface RunCard {
  runId: string;
  mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';
  SkillManifestId?: string;
  hypothesisId?: string;
  startedAt: string;
  endedAt?: string;
  status: 'created' | 'running' | 'completed' | 'failed' | 'rejected';
  metrics: any;
  verdict: 'reject' | 'revise' | 'retest' | 'promote' | 'hold';
  artifacts: string[];
  agentName?: string;
  riskDecision?: any;
  policyDecision?: any;
  summary?: string;
  postmortem?: string;
}

export interface RunCardOptions {
  mode: RunCard['mode'];
  SkillManifestId?: string;
  hypothesisId?: string;
  agentName?: string;
}

export class RunCardManager {
  private logger = new Logger('RunCardManager');
  private audit: AuditTrail;
  private statePath: string;
  private storageReady?: Promise<void>;

  constructor(statePath: string) {
    this.statePath = statePath;
    this.audit = new AuditTrail(statePath);
  }

  async createRunCard(options: RunCardOptions): Promise<RunCard> {
    const runCard: RunCard = {
      runId: uuidv4(),
      mode: options.mode,
      SkillManifestId: options.SkillManifestId,
      hypothesisId: options.hypothesisId,
      startedAt: new Date().toISOString(),
      status: 'created',
      metrics: {},
      verdict: 'hold',
      artifacts: [],
      agentName: options.agentName
    };

    await this.saveRunCard(runCard);
    await this.audit.record({
      type: 'action',
      actor: 'system',
      actorType: 'system',
      action: 'create_run_card',
      resource: `run/${runCard.runId}`,
      result: 'success',
      details: runCard
    });

    this.logger.info(`Created run card: ${runCard.runId}`);
    return runCard;
  }

  async startRun(runId: string): Promise<void> {
    const runCard = await this.loadRunCard(runId);
    runCard.status = 'running';
    runCard.startedAt = new Date().toISOString();

    await this.saveRunCard(runCard);
    await this.audit.record({
      type: 'action',
      actor: 'system',
      actorType: 'system',
      action: 'start_run',
      resource: `run/${runId}`,
      result: 'running',
      details: runCard
    });

    this.logger.info(`Started run: ${runId}`);
  }

  async completeRun(
    runId: string,
    {
      verdict,
      metrics,
      artifacts,
      summary,
      riskDecision,
      policyDecision
    }: {
      verdict?: RunCard['verdict'];
      metrics?: any;
      artifacts?: string[];
      summary?: string;
      riskDecision?: any;
      policyDecision?: any;
    } = {}
  ): Promise<void> {
    const runCard = await this.loadRunCard(runId);

    runCard.status = 'completed';
    runCard.endedAt = new Date().toISOString();
    runCard.verdict = verdict || 'hold';
    runCard.metrics = metrics || {};
    runCard.artifacts = artifacts || [];
    runCard.summary = summary;
    runCard.riskDecision = riskDecision;
    runCard.policyDecision = policyDecision;

    await this.saveRunCard(runCard);
    await this.audit.record({
      type: 'action',
      actor: 'system',
      actorType: 'system',
      action: 'complete_run',
      resource: `run/${runId}`,
      result: 'completed',
      details: runCard
    });

    this.logger.info(`Completed run: ${runId} with verdict: ${verdict}`);
  }

  async rejectRun(runId: string, reason: string): Promise<void> {
    const runCard = await this.loadRunCard(runId);
    runCard.status = 'rejected';
    runCard.summary = reason;

    await this.saveRunCard(runCard);
    await this.audit.record({
      type: 'action',
      actor: 'system',
      actorType: 'system',
      action: 'reject_run',
      resource: `run/${runId}`,
      result: 'rejected',
      details: { reason }
    });

    this.logger.info(`Rejected run: ${runId} - ${reason}`);
  }

  async addArtifact(runId: string, artifact: any, artifactType: string): Promise<string> {
    const runCard = await this.loadRunCard(runId);

    const artifactPath = await this.saveArtifact(runId, artifact, artifactType);
    runCard.artifacts.push(artifactPath);

    await this.saveRunCard(runCard);
    await this.audit.record({
      type: 'action',
      actor: 'system',
      actorType: 'system',
      action: 'add_artifact',
      resource: `run/${runId}`,
      result: 'success',
      details: { artifactType, artifactPath }
    });
    return artifactPath;
  }

  async getRunCard(runId: string): Promise<RunCard | null> {
    try {
      const runCard = await this.loadRunCard(runId);
      return runCard;
    } catch {
      return null;
    }
  }

  async getRunCards(mode?: RunCard['mode'], limit?: number): Promise<RunCard[]> {
    await this.ensureStorageLayout();
    const runsPaths = [
      path.join(this.statePath, 'workspace', 'runs'),
      path.join(this.statePath, 'runs'),
    ];
    let runCards: RunCard[] = [];

    for (const runsPath of runsPaths) {
      try {
        const dateDirs = await fs.readdir(runsPath);

        for (const dateDir of dateDirs) {
          const datePath = path.join(runsPath, dateDir);
          const runDirs = await fs.readdir(datePath);

          for (const runDir of runDirs) {
            const runPath = path.join(datePath, runDir);
            const runCardPath = path.join(runPath, 'run_card.json');

            try {
              const content = await fs.readFile(runCardPath, 'utf-8');
              const runCard = JSON.parse(content);

              if (!mode || runCard.mode === mode) {
                runCards.push(runCard);
              }
            } catch {
              // Skip invalid run cards
            }
          }
        }
      } catch {
        // This run-card location does not exist.
      }
    }

    // Prefer migrated state records if an ID exists in both locations.
    runCards = [...new Map(runCards.map((card) => [card.runId, card])).values()];

    // Sort by startedAt (newest first)
    runCards.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    if (limit) {
      runCards = runCards.slice(0, limit);
    }

    return runCards;
  }

  private async loadRunCard(runId: string): Promise<RunCard> {
    await this.ensureStorageLayout();
    for (const runsPath of [
      path.join(this.statePath, 'runs'),
      path.join(this.statePath, 'workspace', 'runs'),
    ]) {
      let dateDirs: string[];
      try {
        dateDirs = await fs.readdir(runsPath);
      } catch {
        continue;
      }
      for (const dateDir of dateDirs) {
        const runPath = path.join(runsPath, dateDir, runId, 'run_card.json');
        try {
          const content = await fs.readFile(runPath, 'utf-8');
          return JSON.parse(content);
        } catch {
          continue;
        }
      }
    }
    throw new Error(`Run card not found: ${runId}`);
  }

  private async saveRunCard(runCard: RunCard): Promise<void> {
    await this.ensureStorageLayout();
    const date = new Date(runCard.startedAt).toISOString().split('T')[0]!;
    const runPath = path.join(this.statePath, 'runs', date, runCard.runId);

    await fs.mkdir(runPath, { recursive: true });
    const runCardPath = path.join(runPath, 'run_card.json');

    await fs.writeFile(runCardPath, JSON.stringify(runCard, null, 2));
  }

  private ensureStorageLayout(): Promise<void> {
    this.storageReady ??= this.migrateLegacyRuns();
    return this.storageReady;
  }

  private async migrateLegacyRuns(): Promise<void> {
    const legacyRunsPath = path.join(this.statePath, 'workspace', 'runs');
    const runsPath = path.join(this.statePath, 'runs');
    let dateDirs: import('node:fs').Dirent[];
    try {
      dateDirs = await fs.readdir(legacyRunsPath, { withFileTypes: true });
    } catch {
      return;
    }

    await fs.mkdir(runsPath, { recursive: true });
    for (const dateDir of dateDirs) {
      if (!dateDir.isDirectory()) continue;
      const legacyDatePath = path.join(legacyRunsPath, dateDir.name);
      const datePath = path.join(runsPath, dateDir.name);
      await fs.mkdir(datePath, { recursive: true });
      let runDirs: import('node:fs').Dirent[];
      try {
        runDirs = await fs.readdir(legacyDatePath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const runDir of runDirs) {
        if (!runDir.isDirectory()) continue;
        const legacyRunPath = path.join(legacyDatePath, runDir.name);
        const runPath = path.join(datePath, runDir.name);
        try {
          await fs.access(runPath);
          this.logger.warn(`Keeping duplicate legacy run card in place: ${runDir.name}`);
          continue;
        } catch {
          // Destination is absent; move the complete run folder into state/runs.
        }
        try {
          await fs.rename(legacyRunPath, runPath);
          await this.rewriteLegacyArtifactPaths(runPath, legacyRunPath);
        } catch (error) {
          this.logger.warn(`Could not migrate legacy run card ${runDir.name}`, error);
        }
      }
      try { await fs.rmdir(legacyDatePath); } catch { /* Preserve non-empty legacy data. */ }
    }
    try { await fs.rmdir(legacyRunsPath); } catch { /* Preserve non-empty legacy data. */ }
  }

  private async rewriteLegacyArtifactPaths(runPath: string, legacyRunPath: string): Promise<void> {
    const runCardPath = path.join(runPath, 'run_card.json');
    try {
      const runCard = JSON.parse(await fs.readFile(runCardPath, 'utf-8')) as RunCard;
      const legacyPrefix = `${legacyRunPath}${path.sep}`;
      let changed = false;
      runCard.artifacts = runCard.artifacts.map((artifactPath) => {
        if (!artifactPath.startsWith(legacyPrefix)) return artifactPath;
        changed = true;
        return path.join(runPath, artifactPath.slice(legacyPrefix.length));
      });
      if (changed) await fs.writeFile(runCardPath, JSON.stringify(runCard, null, 2));
    } catch {
      // Leave malformed or non-standard run-card files untouched.
    }
  }

  private async saveArtifact(runId: string, artifact: any, artifactType: string): Promise<string> {
    const runCard = await this.loadRunCard(runId);
    const date = new Date(runCard.startedAt).toISOString().split('T')[0]!;
    const runPath = path.join(this.statePath, 'runs', date, runId);

    const artifactPath = path.join(runPath, `${artifactType.toLowerCase()}.json`);
    await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2));

    return artifactPath;
  }
}
