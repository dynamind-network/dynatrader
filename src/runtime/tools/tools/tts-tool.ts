import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

export interface TtsConfig { apiKey?: string; baseUrl?: string; fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>; }

export class TtsTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'voice_synthesize', description: 'Generate speech audio from text', category: 'web',
    inputSchema: { text: 'string', voice: 'string?', format: 'string?', model: 'string?' },
    outputSchema: { audioBase64: 'string', mimeType: 'string', format: 'string' }, permissionsRequired: ['tool.voice_synthesize'],
    sideEffects: ['network_access'], riskLevel: 'low', timeoutMs: 60000,
  };
  private readonly apiKey: string; private readonly baseUrl: string; private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  constructor(config: TtsConfig = {}) { this.apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? ''; this.baseUrl = (config.baseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, ''); this.fetchImpl = config.fetchImpl ?? fetch; }
  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      if (!this.apiKey) throw new Error('OpenAI API key required for text-to-speech');
      if (typeof call.args.text !== 'string' || !call.args.text.trim()) throw new Error('text is required');
      const format = typeof call.args.format === 'string' ? call.args.format : 'mp3';
      if (!['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(format)) throw new Error(`Unsupported audio format: ${format}`);
      const response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: call.args.model ?? 'gpt-4o-mini-tts', voice: call.args.voice ?? 'alloy', input: call.args.text, response_format: format }) });
      if (!response.ok) throw new Error(`TTS API error ${response.status}: ${await response.text().catch(() => '')}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { success: true, data: { audioBase64: Buffer.from(bytes).toString('base64'), mimeType: `audio/${format === 'mp3' ? 'mpeg' : format}`, format }, durationMs: Date.now() - startedAt, truncated: false };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, truncated: false }; }
  }
}
