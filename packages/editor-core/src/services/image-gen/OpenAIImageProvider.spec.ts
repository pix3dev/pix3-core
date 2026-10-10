import { describe, expect, it, vi } from 'vitest';
import { OpenAIImageProvider } from './OpenAIImageProvider';
import { ImageGenError } from './ImageGenTypes';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const errJson = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('OpenAIImageProvider', () => {
  const provider = new OpenAIImageProvider();
  const b64 = 'aGVsbG8='; // "hello"

  it('posts text-to-image as JSON to v1/images/generations through the transport, no key', async () => {
    const fetchImpl = vi.fn(async () => okJson({ data: [{ b64_json: b64 }] }));

    const result = await provider.generate(
      { prompt: 'a red cube', aspectRatio: '16:9', quality: 'high', background: 'transparent' },
      { modelId: 'gpt-image-1.5', transport: fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('v1/images/generations');
    expect(init.method).toBe('POST');
    // The dev server's proxy adds the key; the page has none to send.
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Content-Type']);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-image-1.5',
      prompt: 'a red cube',
      n: 1,
      size: '1536x1024', // 16:9 → landscape
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
    });

    expect(result.images).toEqual([{ mimeType: 'image/png', data: b64 }]);
  });

  it("maps square aspect to 1024x1024 and omits background when 'auto'", async () => {
    const fetchImpl = vi.fn(async () => okJson({ data: [{ b64_json: b64 }] }));

    await provider.generate(
      { prompt: 'x', aspectRatio: '1:1', background: 'auto' },
      { modelId: 'gpt-image-1.5', transport: fetchImpl }
    );

    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    ) as Record<string, unknown>;
    expect(body.size).toBe('1024x1024');
    expect('background' in body).toBe(false);
    expect('quality' in body).toBe(false); // no quality passed
  });

  it('switches to /images/edits (multipart) when references are attached', async () => {
    const fetchImpl = vi.fn(async () => okJson({ data: [{ b64_json: b64 }] }));

    await provider.generate(
      {
        prompt: 'edit this',
        references: [{ mimeType: 'image/png', data: b64 }],
        background: 'transparent',
      },
      { modelId: 'gpt-image-1.5', transport: fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('v1/images/edits');
    // Must NOT set Content-Type manually — the browser adds the multipart boundary.
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('gpt-image-1.5');
    expect(form.get('prompt')).toBe('edit this');
    expect(form.get('background')).toBe('transparent');
    expect(form.getAll('image[]').length).toBe(1);
  });

  it("maps the dev server's no_key refusal to a missing-key error with its message", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'no_key', message: 'No openai API key here.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    await expect(
      provider.generate({ prompt: 'x' }, { modelId: 'gpt-image-1.5', transport: fetchImpl })
    ).rejects.toMatchObject({ kind: 'missing-key', message: 'No openai API key here.' });
  });

  it('maps a 401 to an http ImageGenError carrying the status', async () => {
    const fetchImpl = vi.fn(async () => errJson(401, 'Incorrect API key provided'));
    const error = await provider
      .generate({ prompt: 'x' }, { modelId: 'gpt-image-1.5', transport: fetchImpl })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageGenError);
    expect(error).toMatchObject({ kind: 'http', status: 401 });
  });
});
