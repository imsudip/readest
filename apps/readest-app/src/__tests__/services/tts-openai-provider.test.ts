import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { OpenAISpeechProvider } from '@/services/tts/providers/openai';
import type { OpenAITTSProviderConfig } from '@/services/tts/providers/openaiConfigStore';
import { SpeechSynthesisPermanentError } from '@/services/tts/providers/types';

const config: OpenAITTSProviderConfig = {
  id: 'test-1',
  name: 'Test Kokoro',
  baseUrl: 'http://localhost:8880',
  apiKey: 'secret-key',
  model: 'kokoro',
};

const ok = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

describe('OpenAISpeechProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('init() probes /v1/models and fetches voices, returns true', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: [{ id: 'kokoro' }] }))
      .mockResolvedValueOnce(ok({ voices: ['af_heart', 'am_michael'] }));

    const provider = new OpenAISpeechProvider(config);
    expect(await provider.init()).toBe(true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8880/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8880/v1/audio/voices',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    );
  });

  test('init() returns false when the endpoint is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const provider = new OpenAISpeechProvider(config);
    expect(await provider.init()).toBe(false);
  });

  test('getAllVoices() normalizes string voices with lang inference', async () => {
    fetchMock.mockResolvedValueOnce(ok({ voices: ['af_heart', 'am_michael'] }));
    const provider = new OpenAISpeechProvider(config);
    const voices = await provider.getAllVoices();

    expect(voices).toEqual([
      { id: 'af_heart', name: 'Heart', lang: 'en-US' },
      { id: 'am_michael', name: 'Michael', lang: 'en-US' },
    ]);
  });

  test('getAllVoices() handles structured voice objects', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ voices: [{ id: 'af_heart', name: 'Heart' }, 'am_michael'] }),
    );
    const provider = new OpenAISpeechProvider(config);
    const voices = await provider.getAllVoices();

    expect(voices[0]).toMatchObject({ id: 'af_heart', name: 'Heart', lang: 'en-US' });
    expect(voices[1]).toMatchObject({ id: 'am_michael' });
  });

  test('getAllVoices() treats named voices (KittenTTS/OpenAI style) as English', async () => {
    fetchMock.mockResolvedValueOnce(ok({ voices: ['Bella', 'Jasper', 'alloy'] }));
    const provider = new OpenAISpeechProvider(config);
    const voices = await provider.getAllVoices();

    // Named voices have no Kokoro language prefix: they must resolve to a
    // valid English lang ('en' or 'en-US') or the picker's isSameLang
    // filter drops them.
    expect(voices.every((v) => v.lang === 'en' || v.lang === 'en-US')).toBe(true);
    expect(voices.map((v) => v.id)).toEqual(['Bella', 'Jasper', 'alloy']);
  });

  test('getAllVoices() falls back to OpenAI standard voices on 404 (api.openai.com has no /v1/audio/voices)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Endpoint not found.' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider = new OpenAISpeechProvider({ ...config, baseUrl: 'https://api.openai.com' });
    const voices = await provider.getAllVoices();

    expect(voices.map((v) => v.id).sort()).toEqual(
      ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].sort(),
    );
    expect(voices.every((v) => v.lang === 'en-US')).toBe(true);
  });

  test('synthesize() posts the OpenAI wire format with auth and returns audio', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ArrayBuffer(8), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
    );

    const provider = new OpenAISpeechProvider(config);
    const result = await provider.synthesize(
      { lang: 'en', text: 'Hello world', voice: 'af_heart', pitch: 1.0 },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8880/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          model: 'kokoro',
          input: 'Hello world',
          voice: 'af_heart',
          speed: 1.0,
        }),
      }),
    );
    expect(result.audio.byteLength).toBe(8);
    // OpenAI-compatible engines have no word boundaries: sentence highlight.
    expect(result.boundaries).toEqual([]);
  });

  test('synthesize() defaults the model to tts-1 on api.openai.com', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ArrayBuffer(4), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
    );
    const provider = new OpenAISpeechProvider({
      ...config,
      baseUrl: 'https://api.openai.com',
      model: '',
    });
    await provider.synthesize(
      { lang: 'en', text: 'Hi', voice: 'alloy', pitch: 1.0 },
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('tts-1');
  });

  test('synthesize() dedupes concurrent identical requests (preload + scheduler race)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ArrayBuffer(8), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
    );
    const provider = new OpenAISpeechProvider(config);
    const req = { lang: 'en', text: 'Same sentence', voice: 'af_heart', pitch: 1.0 };
    const [a, b] = await Promise.all([
      provider.synthesize(req, new AbortController().signal),
      provider.synthesize(req, new AbortController().signal),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.audio.byteLength).toBe(8);
    expect(b.audio.byteLength).toBe(8);
  });

  test('synthesize() throws SpeechSynthesisPermanentError on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('nope', { status: 400, statusText: 'Bad Request' }),
    );
    const provider = new OpenAISpeechProvider(config);
    await expect(
      provider.synthesize(
        { lang: 'en', text: 'x', voice: 'v', pitch: 1.0 },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
  });

  test('synthesize() rethrows abort errors (transient, caller handles)', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    const provider = new OpenAISpeechProvider(config);
    await expect(
      provider.synthesize({ lang: 'en', text: 'x', voice: 'v', pitch: 1.0 }, controller.signal),
    ).rejects.toThrow('AbortError');
  });
});
