import { z } from 'zod';
import { createHash } from 'crypto';
import { v5 as uuidv5 } from 'uuid';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function contentId(namespace: string, content: string): string {
  return uuidv5(`dynatrader:${namespace}:${contentHash(content)}`, NAMESPACE);
}

export const CitationSchema = z.object({
  sourceId: z.string(),
  page: z.number().optional(),
  charOffset: z.number().optional(),
  charLength: z.number().optional(),
  quote: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const SourceRefSchema = z.object({
  kind: z.enum(['arxiv', 'url', 'file', 'news', 'api', 'manual']),
  uri: z.string(),
  fetchedAt: z.string().datetime(),
  contentHash: z.string(),
  contentType: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ExtractionRefSchema = z.object({
  method: z.string(),
  model: z.string().optional(),
  extractedAt: z.string().datetime(),
  version: z.string().optional(),
});
export type ExtractionRef = z.infer<typeof ExtractionRefSchema>;

export const ArtifactMetaSchema = z.object({
  id: z.string(),
  kind: z.string(),
  asOf: z.string().datetime(),
  availableAt: z.string().datetime().optional(),
  source: SourceRefSchema,
  extraction: ExtractionRefSchema.optional(),
  citations: z.array(CitationSchema).default([]),
  tags: z.array(z.string()).default([]),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

export const BaseKnowledgeSchema = ArtifactMetaSchema.extend({
  content: z.string(),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type BaseKnowledge = z.infer<typeof BaseKnowledgeSchema>;
