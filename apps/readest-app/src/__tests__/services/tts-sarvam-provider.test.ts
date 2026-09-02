import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { SarvamSpeechProvider } from '@/services/tts/providers/sarvam';
import type { TTSProviderConfig } from '@/services/tts/providers/openaiConfigStore';
import { SpeechSynthesisPermanentError } from '@/services/tts/providers/types';

// A tiny valid WAV header (44 bytes) so byteLength assertions are meaningful.
const WAV_HEADER = 'UklGRgAAAAA=';
const base64Of = (s: string): string => btoa(s);

const config: TTSProviderConfig = {
  id: 'sarvam-1',
  name: 'Sarvam',
  preset: 'sarvam',
  baseUrl: 'https://api.sarvam.ai',
  apiKey: 'sub-key',
  model: 'bulbul:v3',
  languageCode: 'hi-IN',
};

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('SarvamSpeechProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('init() is available only when an api key is present', async () => {
    expect(await new SarvamSpeechProvider(config).init()).toBe(true);
    expect(await new SarvamSpeechProvider({ ...config, apiKey: '' }).init()).toBe(false);
  });

  test('getAllVoices() returns the bulbul:v3 speakers tagged with the configured language', async () => {
    const provider = new SarvamSpeechProvider(config);
    const voices = await provider.getAllVoices();
    expect(voices.length).toBeGreaterThan(20);
    expect(voices.map((v) => v.id)).toContain('shubh');
    // Speakers are tagged with the provider's configured language primary.
    expect(voices.every((v) => v.lang === 'hi')).toBe(true);
  });

  test('bulbul:v2 model exposes the v2 speaker set', async () => {
    const provider = new SarvamSpeechProvider({ ...config, model: 'bulbul:v2' });
    const voices = await provider.getAllVoices();
    expect(voices.map((v) => v.id).sort()).toEqual(
      ['anushka', 'abhilash', 'manisha', 'vidya', 'arya', 'karun', 'hitesh'].sort(),
    );
  });

  test('synthesize() posts to /text-to-speech with subscription-key auth and decodes base64 WAV', async () => {
    const fakeWav = base64Of('RIFF fake wav payload');
    fetchMock.mockResolvedValueOnce(okJson({ request_id: 'abc', audios: [fakeWav, WAV_HEADER] }));
    const provider = new SarvamSpeechProvider(config);
    const result = await provider.synthesize(
      { lang: 'hi', text: 'नमस्ते', voice: 'shubh', pitch: 1 },
      new AbortController().signal,
    );

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('https://api.sarvam.ai/text-to-speech');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['api-subscription-key']).toBe('sub-key');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      text: 'नमस्ते',
      language_code: 'hi-IN', // from config.languageCode
      speaker: 'shubh',
      model: 'bulbul:v3',
      pace: 1.0,
      output_audio_codec: 'wav',
    });
    // Decoded base64 length equals the fake payload length.
    expect(result.audio.byteLength).toBe('RIFF fake wav payload'.length);
    expect(result.boundaries).toEqual([]);
  });

  test('synthesize() maps the request lang to a Sarvam language code when config has none', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ audios: [base64Of('abcd')] }));
    const provider = new SarvamSpeechProvider({ ...config, languageCode: undefined });
    await provider.synthesize(
      { lang: 'ta', text: 'x', voice: 'shubh', pitch: 1 },
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.language_code).toBe('ta-IN');
  });

  test('unsupported request lang falls back to hi-IN', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ audios: [base64Of('abcd')] }));
    const provider = new SarvamSpeechProvider({ ...config, languageCode: undefined });
    await provider.synthesize(
      { lang: 'de', text: 'x', voice: 'shubh', pitch: 1 },
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.language_code).toBe('hi-IN');
  });

  test('synthesize() throws permanent error when apiKey missing', async () => {
    const provider = new SarvamSpeechProvider({ ...config, apiKey: '' });
    await expect(
      provider.synthesize(
        { lang: 'hi', text: 'x', voice: 'shubh', pitch: 1 },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
  });

  test('synthesize() throws permanent error on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('nope', { status: 400, statusText: 'Bad Request' }),
    );
    const provider = new SarvamSpeechProvider(config);
    await expect(
      provider.synthesize(
        { lang: 'hi', text: 'x', voice: 'shubh', pitch: 1 },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
  });

  test('synthesize() throws permanent error when audios array is empty/malformed', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ audios: [] }));
    const provider = new SarvamSpeechProvider(config);
    await expect(
      provider.synthesize(
        { lang: 'hi', text: 'x', voice: 'shubh', pitch: 1 },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
  });
});
