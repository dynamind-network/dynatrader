import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';

export interface VisionToolConfig { apiKey?: string; baseUrl?: string; model?: string; fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>; }

/** Analyze a browser screenshot or other image through an OpenAI-compatible vision model. */
export class VisionTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'vision_analyze', description: 'Analyze an image or browser screenshot with a vision model', category: 'browser',
    inputSchema: { imageUrl: 'string?', imageBase64: 'string?', prompt: 'string?', model: 'string?' },
    outputSchema: { text: 'string', model: 'string' }, permissionsRequired: ['tool.vision_analyze'], sideEffects: ['network_access'], riskLevel: 'low', readOnly: true, timeoutMs: 60000,
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(config: VisionToolConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.baseUrl = (config.baseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = config.model ?? process.env['VISION_MODEL'] ?? 'gpt-4o-mini';
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const started = Date.now();
    try {
      if (!this.apiKey) throw new Error('OpenAI API key required for vision analysis');
      const imageUrl = typeof call.args.imageUrl === 'string' ? call.args.imageUrl : typeof call.args.imageBase64 === 'string' ? `data:image/png;base64,${call.args.imageBase64}` : '';
      if (!imageUrl) throw new Error('imageUrl or imageBase64 is required');
      if (imageUrl.startsWith('data:') === false && !/^https?:\/\//.test(imageUrl)) throw new Error('imageUrl must use http or https');
      const model = typeof call.args.model === 'string' && call.args.model ? call.args.model : this.model;
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: typeof call.args.prompt === 'string' && call.args.prompt ? call.args.prompt : 'Describe this image accurately.' }, { type: 'image_url', image_url: { url: imageUrl } }] }], max_tokens: 1024 }) });
      if (!response.ok) throw new Error(`Vision API error ${response.status}: ${await response.text().catch(() => '')}`);
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('Vision API returned no analysis');
      return { success: true, data: { text, model }, durationMs: Date.now() - started, truncated: false };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, truncated: false }; }
  }
}
