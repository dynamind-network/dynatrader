import { z } from "zod";

// Agent Card — capability advertisement (Google A2A)
export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  url: z.string().url().optional(),
  capabilities: z.object({
    streaming: z.boolean().default(false),
    pushNotifications: z.boolean().default(false),
    stateTransitionHistory: z.boolean().default(false),
  }).default({}),
  authentication: z.object({
    schemes: z.array(z.string()).default([]),
    credentials: z.string().optional(),
  }).optional(),
  defaultInputModes: z.array(z.string()).default(["text"]),
  defaultOutputModes: z.array(z.string()).default(["text"]),
  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
    examples: z.array(z.string()).default([]),
  })).default([]),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

// Task lifecycle (Google A2A)
export const TaskStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  status: z.object({
    state: TaskStateSchema,
    message: z.any().optional(),
    timestamp: z.string().datetime().optional(),
  }),
  artifacts: z.array(z.any()).default([]),
  history: z.array(z.any()).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type Task = z.infer<typeof TaskSchema>;

// A2A Message
export const A2AMessageSchema = z.object({
  role: z.enum(["user", "agent"]),
  parts: z.array(z.object({
    type: z.enum(["text", "file", "data"]),
    text: z.string().optional(),
    data: z.unknown().optional(),
    mimeType: z.string().optional(),
  })),
  metadata: z.record(z.unknown()).default({}),
});
export type A2AMessage = z.infer<typeof A2AMessageSchema>;

// A2A Request/Response
export const A2ARequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});
export type A2ARequest = z.infer<typeof A2ARequestSchema>;

export const A2AResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
});
export type A2AResponse = z.infer<typeof A2AResponseSchema>;

// Input provenance
export const InputProvenanceSchema = z.object({
  kind: z.enum(["user", "inter_session", "channel", "webhook"]),
  sourceSessionKey: z.string().optional(),
  sourceChannel: z.string().optional(),
  sourceTool: z.string().optional(),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
});
export type InputProvenance = z.infer<typeof InputProvenanceSchema>;

// A2A Security Policy
export const A2APolicySchema = z.object({
  enabled: z.boolean().default(false),
  allow: z.array(z.string()).default([]),
  maxPingPongTurns: z.number().min(0).max(10).default(5),
  announceTimeoutMs: z.number().default(300000),
  visibility: z.enum(["self", "tree", "agent", "all"]).default("tree"),
});
export type A2APolicy = z.infer<typeof A2APolicySchema>;

// Gateway call interface
export interface GatewayClient {
  call<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  callWait<T>(runId: string, timeoutMs: number): Promise<T>;
  history(sessionKey: string, limit?: number): Promise<{ messages: Array<{ role: string; content?: string; text?: string }> }>;
  send(params: { to: string; message: string; channel?: string; accountId?: string }): Promise<void>;
}
