import { describe, expect, it, vi } from 'vitest';
import { VoiceTranscriptionTool } from './voice-transcription-tool';
import { TtsTool } from './tts-tool';

function jsonResponse(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }

describe('Voice tools', () => {
  it('transcribes base64 audio using multipart form data', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ text: 'analyze BTC', language: 'en' }));
    const tool = new VoiceTranscriptionTool({ apiKey: 'key', baseUrl: 'https://openai.test/v1', fetchImpl: fetchMock as unknown as (input: string | URL, init?: RequestInit) => Promise<Response> });
    const result = await tool.execute({ tool: 'voice_transcribe', args: { audioBase64: Buffer.from('audio').toString('base64') } });
    expect(result.success).toBe(true);
    expect((result.data as { text: string }).text).toBe('analyze BTC');
    expect(fetchMock).toHaveBeenCalledWith('https://openai.test/v1/audio/transcriptions', expect.objectContaining({ method: 'POST' }));
  });

  it('returns synthesized audio as base64', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const tool = new TtsTool({ apiKey: 'key', baseUrl: 'https://openai.test/v1', fetchImpl: fetchMock as unknown as (input: string | URL, init?: RequestInit) => Promise<Response> });
    const result = await tool.execute({ tool: 'voice_synthesize', args: { text: 'hello', format: 'mp3' } });
    expect(result.success).toBe(true);
    expect((result.data as { audioBase64: string }).audioBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });
});
