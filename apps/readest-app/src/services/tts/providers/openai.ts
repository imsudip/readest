// OpenAI-compatible TTS as a SpeechProvider. Speaks any endpoint that
// implements the OpenAI wire format:
//   GET  {baseUrl}/v1/models          -> { data: [{ id }] }
//   GET  {baseUrl}/v1/audio/voices    -> string[] | { voices: string[] }
//   POST {baseUrl}/v1/audio/speech    -> audio bytes
// with `Authorization: Bearer <apiKey>`.
//
// OpenAI-compatible engines do not return word-boundary timings, so
// `boundaries` is always empty — the buffered client degrades word
// highlighting to sentence highlighting, which is the seam's designed
// fallback. Rate is pinned at 1.0 (playout applies the playback rate), and
// pitch is unsupported by the protocol, so it is ignored.

import type { TTSVoice } from '../types';
import type { OpenAITTSProviderConfig } from './openaiConfigStore';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

const DEFAULT_MODEL = 'kokoro';

// Real OpenAI's documented TTS voice set, used when the endpoint does not
// expose /v1/audio/voices (Kokoro-FastAPI does; api.openai.com does not).
const OPENAI_STANDARD_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

// Voice IDs follow the Kokoro convention (e.g. "af_heart"): the first letter
// encodes the language. Map the ones we know; anything else falls back to
// the voice id itself so the picker still shows a usable name.
const LANG_FROM_PREFIX: Record<string, string> = {
  a: 'en-US', // American English
  b: 'en-GB', // British English
  e: 'es-ES', // Spanish (Spain)
  f: 'fr-FR', // French (France)
  h: 'hi-IN', // Hindi (India)
  i: 'it-IT', // Italian
  j: 'ja-JP', // Japanese
  p: 'pt-BR', // Portuguese (Brazil)
  z: 'zh-CN', // Mandarin Chinese (Simplified)
};

const voiceLang = (voiceId: string): string => {
  // Kokoro-style voice ids encode the language in the first lowercase letter
  // (af_heart -> en-US). Named voices (KittenTTS: "Bella", OpenAI: "alloy")
  // carry no language marker; default them to English rather than inventing
  // an invalid code that the voice picker's lang filter would drop.
  const first = voiceId[0] ?? '';
  const fromPrefix = first === first.toLowerCase() ? LANG_FROM_PREFIX[first] : undefined;
  if (fromPrefix) return fromPrefix;
  return 'en';
};

const voiceName = (voiceId: string): string =>
  voiceId
    .replace(/^[a-z]+_/, '')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || voiceId;

export class OpenAISpeechProvider implements SpeechProvider {
  readonly id = 'openai-tts';
  readonly label: string;
  readonly fallbackVoiceId = '';
  readonly cacheable = false;

  #config: OpenAITTSProviderConfig;
  #voices: TTSVoice[] = [];
  // In-flight dedup: the buffered client prefetches the first sentences and
  // the playback scheduler then requests the same text again. Deduping by
  // request key means the second caller awaits the first fetch instead of
  // doubling the load on the engine (see BufferedTTSClient.#preload).
  #inflight = new Map<string, Promise<SpeechSynthesisResult>>();

  constructor(config: OpenAITTSProviderConfig) {
    this.#config = config;
    this.label = config.name || 'OpenAI Compatible TTS';
  }

  get config(): OpenAITTSProviderConfig {
    return this.#config;
  }

  // True when the base URL points at OpenAI's own API, where the TTS model
  // defaults to tts-1 (Kokoro-style endpoints default to kokoro).
  get #isOpenAIHost(): boolean {
    const { baseUrl } = this.#config;
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      return host === 'api.openai.com' || host.endsWith('.openai.com');
    } catch {
      return false;
    }
  }

  // Probe the endpoint and cache the voice list. False means the engine is
  // unreachable (its voices render disabled in the picker).
  async init(): Promise<boolean> {
    try {
      await this.#fetchModels();
      this.#voices = await this.#fetchVoices();
      return true;
    } catch {
      return false;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    if (this.#voices.length === 0) {
      this.#voices = await this.#fetchVoices().catch(() => []);
    }
    return this.#voices;
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const key = `${req.voice}|${req.text}`;
    const inflight = this.#inflight.get(key);
    if (inflight) return inflight;

    const promise = this.#synthesizeOnce(req, signal).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, promise);
    return promise;
  }

  async #synthesizeOnce(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const { baseUrl, apiKey, model } = this.#config;
    const resolvedModel = model || (this.#isOpenAIHost ? 'tts-1' : DEFAULT_MODEL);
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/*',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: resolvedModel,
          input: req.text,
          voice: req.voice,
          // Rate is a playout concern; keep the synthesized audio
          // rate-independent (and therefore cacheable downstream).
          speed: 1.0,
        }),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new Error(
        `OpenAI TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = `OpenAI TTS API error ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      // The engine answered without audio: retrying the same sentence
      // cannot succeed, so classify it as permanent for the skip path.
      throw new SpeechSynthesisPermanentError(message, { cause: response });
    }

    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      throw new SpeechSynthesisPermanentError('OpenAI TTS returned no audio data');
    }

    // No word-boundary timings from OpenAI-compatible engines: sentence
    // highlighting is the designed degradation.
    return { audio, boundaries: [] };
  }

  async #fetchModels(): Promise<string[]> {
    const { baseUrl, apiKey } = this.#config;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('Timeout')), 5000);
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as { data?: { id: string }[] };
      return data.data?.map((m) => m.id) ?? [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async #fetchVoices(): Promise<TTSVoice[]> {
    const { baseUrl, apiKey } = this.#config;
    const normalized = baseUrl.replace(/\/+$/, '');
    const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('Timeout')), 5000);
    try {
      const response = await fetch(`${normalized}/v1/audio/voices`, {
        headers: { Accept: 'application/json', ...authHeaders },
        signal: controller.signal,
      });
      if (response.ok) {
        const data = (await response.json()) as
          | { voices?: string[] | { id?: string; name?: string }[] }
          | string[];
        const raw = Array.isArray(data) ? data : (data.voices ?? []);
        return raw.map((voice) => {
          if (typeof voice === 'string') {
            return { id: voice, name: voiceName(voice), lang: voiceLang(voice) };
          }
          const id = voice.id ?? '';
          return { id, name: voice.name || voiceName(id), lang: voiceLang(id) };
        });
      }
      // 404: no /v1/audio/voices endpoint (e.g. real OpenAI). Fall back to
      // OpenAI's documented TTS voice set so the picker still works.
      return OPENAI_STANDARD_VOICES.map((voice) => ({
        id: voice,
        name: voiceName(voice),
        lang: 'en-US',
      }));
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
