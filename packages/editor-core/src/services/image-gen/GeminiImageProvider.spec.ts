import { describe, expect, it, vi } from 'vitest';

import { GeminiImageProvider } from './GeminiImageProvider';

describe('GeminiImageProvider', () => {
  const provider = new GeminiImageProvider();

  it('posts generateContent through the transport with no key of its own', async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }] } },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    const result = await provider.generate(
      { prompt: 'a red cube', aspectRatio: '1:1', imageSize: '1K' },
      { modelId: 'gemini-3.1-flash-image', transport }
    );
    const [path, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      generationConfig: { imageConfig: { aspectRatio: '1:1', imageSize: '1K' } },
    });
    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'aGk=' }]);
  });

  it("maps the dev server's refusals and keeps the provider's own errors", async () => {
    const answer = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status }));
    await expect(
      provider.generate(
        { prompt: 'x' },
        {
          modelId: 'gemini-3.1-flash-image',
          transport: answer(409, { error: 'no_key', message: 'No gemini API key.' }),
        }
      )
    ).rejects.toMatchObject({ kind: 'missing-key', message: 'No gemini API key.' });
    await expect(
      provider.generate(
        { prompt: 'x' },
        {
          modelId: 'gemini-3.1-flash-image',
          transport: answer(400, { error: { message: 'API key not valid.' } }),
        }
      )
    ).rejects.toMatchObject({ kind: 'http', status: 400, message: 'API key not valid.' });
  });
});
