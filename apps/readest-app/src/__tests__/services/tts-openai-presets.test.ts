import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { OpenAISpeechProvider, resolveApiRoot } from '@/services/tts/providers/openai';
import type { TTSProviderConfig } from '@/services/tts/providers/openaiConfigStore';

const ok = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const okAudio = (bytes = 8) =>
  new Response(new ArrayBuffer(bytes), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });

describe('resolveApiRoot', () => {
  test('api-v1 style uses the base URL as-is', () => {
    expect(resolveApiRoot('https://api.openai.com/v1', 'api-v1')).toBe('https://api.openai.com/v1');
    expect(resolveApiRoot('https://openrouter.ai/api/v1/', 'api-v1')).toBe(
      'https://openrouter.ai/api/v1',
    );
  });

  test('root-v1 style appends /v1', () => {
    expect(resolveApiRoot('http://localhost:8880', 'root-v1')).toBe('http://localhost:8880/v1');
  });
});

describe('OpenAISpeechProvider preset routing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('openai preset: static voices, speech hits {base}/audio/speech with tts-1', async () => {
    const provider = new OpenAISpeechProvider({
      id: 'p1',
      name: 'OpenAI',
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: '',
    } satisfies TTSProviderConfig);

    // init probes models once; voices come from the preset static list.
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: 'tts-1' }, { id: 'gpt-4o-mini-tts' }] }));
    expect(await provider.init()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );

    const voices = await provider.getAllVoices();
    expect(voices.map((v) => v.id).sort()).toEqual(
      ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].sort(),
    );
    // Static OpenAI voices are all English.
    expect(voices.every((v) => v.lang === 'en-US')).toBe(true);

    // synthesize: no model in config -> preset default tts-1
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(okAudio());
    const result = await provider.synthesize(
      { lang: 'en', text: 'hi', voice: 'alloy', pitch: 1 },
      new AbortController().signal,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'tts-1',
          input: 'hi',
          voice: 'alloy',
          speed: 1.0,
          response_format: 'mp3',
        }),
      }),
    );
    expect(result.audio.byteLength).toBe(8);
  });

  test('openrouter preset: models filtered by output_modalities=speech, voices come from model supported_voices', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        data: [
          {
            id: 'openai/gpt-4o-mini-tts',
            supported_voices: ['alloy', 'nova'],
          },
          {
            id: 'microsoft/mai-voice-2',
            supported_voices: ['en-US-Harper:MAI-Voice-2'],
          },
          { id: 'some/cloning-model', supported_voices: null },
        ],
      }),
    );

    const provider = new OpenAISpeechProvider({
      id: 'p2',
      name: 'OpenRouter',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-xxx',
      model: 'microsoft/mai-voice-2',
    } satisfies TTSProviderConfig);

    expect(await provider.init()).toBe(true);
    // The model list must be fetched with the speech-modality filter.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models?output_modalities=speech',
      expect.anything(),
    );

    const voices = await provider.getAllVoices();
    // Only the configured model's voices are exposed.
    expect(voices.map((v) => v.id)).toEqual(['en-US-Harper:MAI-Voice-2']);
    // Azure-style MAI ids resolve their region.
    expect(voices[0]?.lang).toBe('en-US');

    // synthesize posts to {base}/audio/speech (api-v1 base)
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(okAudio());
    await provider.synthesize(
      { lang: 'en-US', text: 'x', voice: 'en-US-Harper:MAI-Voice-2', pitch: 1 },
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(body.model).toBe('microsoft/mai-voice-2');
  });

  test('openrouter cloning model (supported_voices null) surfaces an explicit config.voice', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ data: [{ id: 'fish-audio/s2.1-pro', supported_voices: null }] }),
    );
    const provider = new OpenAISpeechProvider({
      id: 'p3',
      name: 'Clone',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      model: 'fish-audio/s2.1-pro',
      voice: 'my-voice',
    } satisfies TTSProviderConfig);
    await provider.init();
    const voices = await provider.getAllVoices();
    // The explicit voice is the only selectable one.
    expect(voices.map((v) => v.id)).toEqual(['my-voice']);
  });

  test('openrouter supported voices infer language from their id (Deepgram suffix, MAI prefix, Mistral prefix)', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        data: [
          {
            id: 'deepgram/aura-2',
            supported_voices: ['aura-2-thalia-en', 'aura-2-agathe-fr', 'aura-2-aurelia-de'],
          },
          {
            id: 'mistralai/voxtral-mini-tts-2603',
            supported_voices: ['en_paul_sad', 'gb_oliver_neutral', 'fr_marie_neutral'],
          },
        ],
      }),
    );
    const deepgram = new OpenAISpeechProvider({
      id: 'dg',
      name: 'DG',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      model: 'deepgram/aura-2',
    } satisfies TTSProviderConfig);
    await deepgram.init();
    const dgVoices = await deepgram.getAllVoices();
    expect(dgVoices.find((v) => v.id === 'aura-2-thalia-en')?.lang).toBe('en-US');
    expect(dgVoices.find((v) => v.id === 'aura-2-agathe-fr')?.lang).toBe('fr-FR');
    expect(dgVoices.find((v) => v.id === 'aura-2-aurelia-de')?.lang).toBe('de-DE');

    const mistral = new OpenAISpeechProvider({
      id: 'ms',
      name: 'MS',
      preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      model: 'mistralai/voxtral-mini-tts-2603',
    } satisfies TTSProviderConfig);
    fetchMock.mockResolvedValueOnce(
      ok({
        data: [
          {
            id: 'mistralai/voxtral-mini-tts-2603',
            supported_voices: ['en_paul_sad', 'gb_oliver_neutral', 'fr_marie_neutral'],
          },
        ],
      }),
    );
    await mistral.init();
    const msVoices = await mistral.getAllVoices();
    expect(msVoices.find((v) => v.id === 'en_paul_sad')?.lang).toBe('en-US');
    expect(msVoices.find((v) => v.id === 'gb_oliver_neutral')?.lang).toBe('en-GB');
    expect(msVoices.find((v) => v.id === 'fr_marie_neutral')?.lang).toBe('fr-FR');
  });

  test('legacy custom config on api.openai.com root resolves to /v1 and defaults to tts-1', async () => {
    // No preset set -> legacy custom path.
    const provider = new OpenAISpeechProvider({
      id: 'p4',
      name: 'Legacy OpenAI',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
      model: '',
    } satisfies TTSProviderConfig);

    fetchMock.mockResolvedValueOnce(ok({ data: [] })); // models probe
    await provider.init();
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.anything());

    // synthesize uses /v1/audio/speech and model tts-1.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(okAudio());
    await provider.synthesize(
      { lang: 'en', text: 'hi', voice: 'alloy', pitch: 1 },
      new AbortController().signal,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/audio/speech');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('tts-1');
  });

  test('legacy custom config on a local kokoro host keeps root-v1 + audio/voices and kokoro default', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: [{ id: 'kokoro' }] })) // models
      .mockResolvedValueOnce(ok({ voices: ['af_heart', 'am_michael'] })); // audio/voices
    const provider = new OpenAISpeechProvider({
      id: 'p5',
      name: 'Kokoro',
      baseUrl: 'http://localhost:8880',
      apiKey: '',
      model: '',
    } satisfies TTSProviderConfig);
    expect(await provider.init()).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8880/v1/models');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:8880/v1/audio/voices');
    const voices = await provider.getAllVoices();
    expect(voices.map((v) => v.id)).toEqual(['af_heart', 'am_michael']);
  });

  test('kokoro preset reads /v1/audio/voices under the root-v1 base', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: [{ id: 'kokoro' }] }))
      .mockResolvedValueOnce(ok({ voices: ['af_heart', 'am_michael'] }));
    const provider = new OpenAISpeechProvider({
      id: 'p6',
      name: 'Kokoro',
      preset: 'kokoro',
      baseUrl: 'http://localhost:8880',
      model: 'kokoro',
    } satisfies TTSProviderConfig);
    expect(await provider.init()).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:8880/v1/audio/voices');
  });

  test('azure preset: speech posts to deployment path with api-version; no models probe on init', async () => {
    const provider = new OpenAISpeechProvider({
      id: 'p7',
      name: 'Azure',
      preset: 'azure',
      baseUrl: 'https://myres.openai.azure.com/openai',
      apiKey: 'az-key',
      model: 'tts-deployment-1',
    } satisfies TTSProviderConfig);

    // modelsDisabled -> init does NOT call /models
    expect(await provider.init()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(okAudio());
    await provider.synthesize(
      { lang: 'en', text: 'x', voice: 'alloy', pitch: 1 },
      new AbortController().signal,
    );
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/openai/deployments/tts-deployment-1/audio/speech');
    expect(url).toContain('api-version=');
    expect(url).toContain('https://myres.openai.azure.com');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['api-key']).toBe('az-key');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('tts-deployment-1');
  });
});
