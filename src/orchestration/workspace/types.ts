export interface RuntimeConfig {
  workspacePath: string;
  mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';
  strictMode: boolean;
  requireRiskProfile: boolean;
  requireTradingPolicy: boolean;
  requireAuthConfig: boolean;
  liveTradingEnabled: boolean;
  enableShadowMode: boolean;
  enableMicroLiveMode: boolean;
  memoryBackend?: 'in-memory' | 'sqlite';
  /** Environment variable name for wallet private key (default: WALLET_PRIVATE_KEY) */
  walletPrivateKeyEnvVar?: string;
  /** Chain IDs to initialize wallets for */
  walletChains?: number[];
}

export interface WorkspaceManifest {
  soul?: string;
  identity?: string;
  user?: string;
  memory?: string;
  auth?: any;
  config?: any;
  agents: AgentManifest[];
  skills: SkillManifest[];
  loops: LoopManifest[];
  plugins: PluginManifest[];
  tools: ToolManifest[];
  adapters: AdapterManifest[];
  policies: PolicyManifest[];
}

export interface AgentManifest {
  name: string;
  version: string;
  description: string;
  allowedModes: RuntimeMode[];
  permissions: PermissionSet;
  tools: ToolPermissions;
  skills: SkillPermissions;
  memory: MemoryPermissions;
  outputs: ArtifactType[];
  approvalRequiredFor: string[];
  riskLevel: RiskLevel;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  status: SkillStatus;
  allowedModes: RuntimeMode[];
  permissions: PermissionSet;
  toolsRequired: string[];
  inputs: any;
  outputs: any;
  riskLevel: RiskLevel;
  review: SkillReview;
  security: SkillSecurity;
}

export interface LoopManifest {
  id: string;
  name: string;
  description: string;
  schedule: string;
  prompt?: string;
  skills: string[];
  tags: string[];
  enabled: boolean;
  repeatCount?: number | null;
  pipeline?: 'analysis' | 'execution' | 'monitoring' | 'research';
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  executionPolicy?: 'trade' | 'close-only';
  deliver?: {
    target: 'telegram' | 'discord' | 'local' | 'none';
    chatId?: string;
  };
  command?: string;
}

export interface ToolManifest {
  name: string;
  version: string;
  description: string;
  adapter: string;
  inputSchema: string;
  outputSchema: string;
  allowedModes: RuntimeMode[];
  permissionsRequired: string[];
  approvalRequired: boolean;
  riskLevel: RiskLevel;
  sideEffects: SideEffects;
}

export interface AdapterManifest {
  name: string;
  version: string;
  type: 'execution' | 'market_data' | 'broker' | 'memory' | 'model';
  description: string;
  capabilities: string[];
  allowedModes: RuntimeMode[];
  permissionsRequired: string[];
  requiresApproval: boolean;
  healthcheck: HealthcheckConfig;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: {
    network?: boolean;
    filesystem?: boolean;
    credentials?: boolean;
    orderExecution?: boolean;
  };
  hooks: Array<{
    event: string;
    handler: string;
    timeout?: number;
    failurePolicy?: 'fail_closed' | 'fail_open' | 'warn_only';
  }>;
  riskLevel?: RiskLevel;
  allowedModes?: RuntimeMode[];
  dependencies?: string[];
}

export interface PolicyManifest {
  name: string;
  filename?: string;
  version: string;
  description: string;
  rules: PolicyRule[];
}

export interface RunCard {
  runId: string;
  mode: RuntimeMode;
  SkillManifestId: string;
  hypothesisId: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  metrics: any;
  verdict: RunVerdict;
  artifacts: string[];
}

// Type aliases
export type RuntimeMode = 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type SkillStatus = 'draft' | 'validated' | 'sandboxed' | 'backtested' | 'paper_approved' | 'shadow_eligible' | 'micro_live_eligible' | 'live_eligible' | 'deprecated';
export type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'rejected';
export type RunVerdict = 'reject' | 'revise' | 'retest' | 'promote' | 'hold';

// Permission structures
export interface PermissionSet {
  allow: string[];
  deny: string[];
}

export interface ToolPermissions {
  allow: string[];
  deny: string[];
}

export interface SkillPermissions {
  allow: string[];
  deny: string[];
}

export interface MemoryPermissions {
  read: string[];
  write: string[];
}

export type ArtifactType =
  | 'Observation'
  | 'Hypothesis'
  | 'SkillManifest'
  | 'ValidationResult'
  | 'RiskDecision'
  | 'PolicyDecision'
  | 'RunCard'
  | 'Postmortem'
  | 'MemoryEvent';

export interface SideEffects {
  readsMarketData: boolean;
  writesMemory: boolean;
  runsBacktest: boolean;
  runsPaperTrade: boolean;
  runsShadowTrade: boolean;
  runsLiveTrade: boolean;
  modifiesPolicy: boolean;
  modifiesRiskProfile: boolean;
}

export interface SkillReview {
  humanRequired: boolean;
  testsRequired: boolean;
  signatureRequired: boolean;
}

export interface SkillSecurity {
  allowNetwork: boolean;
  allowFilesystem: boolean;
  allowCredentials: boolean;
  allowOrderExecution: boolean;
}

export interface HealthcheckConfig {
  enabled: boolean;
  intervalSeconds: number;
}

export interface PolicyRule {
  name: string;
  condition: string;
  action: 'allow' | 'deny' | 'require_approval';
  requiredApprovals?: string[];
  auditLevel: 'low' | 'medium' | 'high' | 'critical';
}

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

export interface RuntimeStatus {
  state: 'idle' | 'starting' | 'running' | 'shutting-down' | 'stopped' | 'error';
  startedAt?: Date;
  workspacePath: string;
  mode: RuntimeConfig['mode'];
  components: {
    memory: boolean;
    modelRouter: boolean;
    toolRegistry: boolean;
    pluginRuntime: boolean;
    agentCore: boolean;
    loopSync: boolean;
    exchange: boolean;
    eventBus: boolean;
    auditTrail: boolean;
    pipeline: boolean;
    cronEngine: boolean;
    skillFactory: boolean;
    /** Compatibility alias for the historical skill review component. */
    skillReviewer: boolean;
    crossSessionRecall: boolean;
    skillLoader: boolean;
    dreamEngine: boolean;
    dreamScheduler: boolean;
    paperEngine: boolean;
    executionRouter: boolean;
    a2aRuntime: boolean;
    agentRegistry: boolean;
    subagentRuntime: boolean;
    memoryBridge: boolean;
    compactionEngine: boolean;
    walletManager: boolean;
    approvalManager: boolean;
    txPipeline: boolean;
    dexAdapters: boolean;
    mcpRuntime: boolean;
  };
}
