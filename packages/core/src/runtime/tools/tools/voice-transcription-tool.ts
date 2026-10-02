import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

export interface VoiceTranscriptionConfig { apiKey?: string; baseUrl?: string; fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>; }

export class VoiceTranscriptionTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'voice_transcribe', description: 'Transcribe an audio file with Whisper', category: 'web',
    inputSchema: { audioUrl: 'string?', audioBase64: 'string?', filename: 'string?', language: 'string?', model: 'string?' },
    outputSchema: { text: 'string', language: 'string?', duration: 'number?' }, permissionsRequired: ['tool.voice_transcribe'],
    sideEffects: ['network_access'], riskLevel: 'low', readOnly: true, timeoutMs: 60000,
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(config: VoiceTranscriptionConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.baseUrl = (config.baseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      if (!this.apiKey) throw new Error('OpenAI API key required for transcription');
      const form = new FormData();
      const filename = typeof call.args.filename === 'string' ? call.args.filename : 'voice.ogg';
      if (typeof call.args.audioBase64 === 'string' && call.args.audioBase64) {
        form.append('file', new Blob([decodeBase64(call.args.audioBase64)]), filename);
      } else if (typeof call.args.audioUrl === 'string' && call.args.audioUrl) {
        const parsed = new URL(call.args.audioUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('audioUrl must use http or https');
        const response = await this.fetchImpl(parsed, { headers: { Accept: 'audio/*,application/octet-stream' } });
        if (!response.ok) throw new Error(`Audio download failed: ${response.status}`);
        form.append('file', new Blob([await response.arrayBuffer()]), filename);
      } else throw new Error('audioUrl or audioBase64 is required');
      form.append('model', typeof call.args.model === 'string' ? call.args.model : 'whisper-1');
      if (typeof call.args.language === 'string' && call.args.language) form.append('language', call.args.language);
      const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form });
      if (!response.ok) throw new Error(`Transcription API error ${response.status}: ${await response.text().catch(() => '')}`);
      const data = await response.json() as { text?: string; language?: string; duration?: number };
      if (!data.text) throw new Error('Transcription API returned no text');
      return { success: true, data, durationMs: Date.now() - startedAt, truncated: false };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, truncated: false }; }
  }
}

function decodeBase64(value: string): Uint8Array { const binary = Buffer.from(value, 'base64'); return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength); }
