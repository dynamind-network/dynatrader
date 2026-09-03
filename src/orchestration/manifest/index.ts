import { z } from 'zod';

// Agent manifest schema
const AgentManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  allowedModes: z.array(z.enum(['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'])),
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string())
  }),
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string())
  }),
  skills: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string())
  }),
  memory: z.object({
    read: z.array(z.string()),
    write: z.array(z.string())
  }),
  outputs: z.array(z.string()),
  approvalRequiredFor: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical'])
});

// Skill manifest schema
const SkillManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  status: z.enum(['draft', 'validated', 'sandboxed', 'backtested', 'paper_approved', 'shadow_eligible', 'micro_live_eligible', 'live_eligible', 'deprecated']),
  allowedModes: z.array(z.enum(['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'])),
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string())
  }),
  toolsRequired: z.array(z.string()),
  inputs: z.any(),
  outputs: z.any(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  review: z.object({
    humanRequired: z.boolean(),
    testsRequired: z.boolean(),
    signatureRequired: z.boolean()
  }),
  security: z.object({
    allowNetwork: z.boolean(),
    allowFilesystem: z.boolean(),
    allowCredentials: z.boolean(),
    allowOrderExecution: z.boolean()
  })
});

// Loop manifest schema
const LoopManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  schedule: z.string(),
  prompt: z.string().optional(),
  skills: z.array(z.string()),
  tags: z.array(z.string()),
  enabled: z.boolean(),
  repeatCount: z.number().nullable().optional(),
  pipeline: z.enum(['analysis', 'execution', 'monitoring', 'research']).optional(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
  executionPolicy: z.enum(['trade', 'close-only']).optional(),
  deliver: z.object({
    target: z.enum(['telegram', 'discord', 'local', 'none']),
    chatId: z.string().optional(),
  }).optional(),
  command: z.string().optional(),
}).refine((data) => Boolean(data.prompt?.trim()) || Boolean(data.command?.trim()), {
  message: 'Loop manifest requires either prompt or command',
});

// Tool manifest schema
const ToolManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  adapter: z.string(),
  inputSchema: z.string(),
  outputSchema: z.string(),
  allowedModes: z.array(z.enum(['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'])),
  permissionsRequired: z.array(z.string()),
  approvalRequired: z.boolean(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  sideEffects: z.object({
    readsMarketData: z.boolean(),
    writesMemory: z.boolean(),
    runsBacktest: z.boolean(),
    runsPaperTrade: z.boolean(),
    runsShadowTrade: z.boolean(),
    runsLiveTrade: z.boolean(),
    modifiesPolicy: z.boolean(),
    modifiesRiskProfile: z.boolean()
  })
});

// Adapter manifest schema
const AdapterManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  type: z.enum(['execution', 'market_data', 'broker', 'memory', 'model']),
  description: z.string(),
  capabilities: z.array(z.string()),
  allowedModes: z.array(z.enum(['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'])),
  permissionsRequired: z.array(z.string()),
  requiresApproval: z.boolean(),
  healthcheck: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number()
  })
});

// Policy manifest schema
const PolicyManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  rules: z.array(z.object({
    name: z.string(),
    condition: z.string(),
    action: z.enum(['allow', 'deny', 'require_approval']),
    requiredApprovals: z.array(z.string()).optional(),
    auditLevel: z.enum(['low', 'medium', 'high', 'critical'])
  }))
});

export class ManifestValidator {
  static validateAgentManifest(data: any) {
    return AgentManifestSchema.safeParse(data);
  }

  static validateSkillManifest(data: any) {
    return SkillManifestSchema.safeParse(data);
  }

  static validateLoopManifest(data: any) {
    return LoopManifestSchema.safeParse(data);
  }

  static validateToolManifest(data: any) {
    return ToolManifestSchema.safeParse(data);
  }

  static validateAdapterManifest(data: any) {
    return AdapterManifestSchema.safeParse(data);
  }

  static validatePolicyManifest(data: any) {
    return PolicyManifestSchema.safeParse(data);
  }
}

export * from './loader';
