// OpenAI-compatible TTS as a SpeechProvider. Speaks any endpoint that
// implements the OpenAI wire format:
//   GET  {apiRoot}/models               -> { data: [{ id, ... }] }
//   GET  {apiRoot}/audio/voices         -> string[] | { voices: string[] }
//   POST {apiRoot}/audio/speech         -> audio bytes
// with `Authorization: Bearer <apiKey>` (or a preset-specific auth header).
//
// The provider is preset-aware: each preset descriptor (providers/presets.ts)
// tells the engine how to resolve the API root (some base URLs already end in
// /v1 — OpenAI, OpenRouter — while others are service roots that get /v1
// appended — Kokoro local, Azure), whether the models list must be filtered by
// output modality (OpenRouter only exposes TTS models under
// `?output_modalities=speech`), and where voices come from (a `/audio/voices`
// endpoint, per-model `supported_voices` returned by the models list, or a
// static list shipped with the preset — OpenAI has no voice-listing endpoint).
//
// OpenAI-compatible engines do not return word-boundary timings, so
// `boundaries` is always empty — the buffered client degrades word
// highlighting to sentence highlighting, which is the seam's designed
// fallback. Rate is pinned at 1.0 (playout applies the playback rate), and
// pitch is unsupported by the protocol, so it is ignored.

import type { TTSVoice } from '../types';
import type { TTSProviderConfig } from './openaiConfigStore';
import { getPreset, type TTSProviderPreset, type TTSUrlStyle } from './presets';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

// Real OpenAI's documented TTS voice set, used when the endpoint does not
// expose a voice list and the preset has no static list of its own.
const OPENAI_STANDARD_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

// Default model for legacy `custom` (preset-less) configs that are not
// OpenAI-hosted — Kokoro-FastAPI style local endpoints default to kokoro.
const DEFAULT_MODEL = 'kokoro';

// Voice IDs follow the Kokoro convention (e.g. "af_heart"): the first letter
// encodes the language. Map the ones we know; anything else falls back to the
// voice id itself so the picker still shows a usable name.
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

// Best-effort language extraction for voice ids that carry their own language
// tag beyond the single-letter Kokoro prefix. Azure MAI voices are
// `en-US-Harper:MAI-Voice-2`; Deepgram/Kokoro are `af_heart` or
// `aura-2-thalia-en`; Mistral are `en_paul_sad`. Handles:
//   - `xx-YY-...` leading region tags     -> "xx-YY"
//   - `...-en` trailing language suffix   -> that language (Deepgram etc.)
//   - `xx_name` / `xx-name` language prefix (en, gb, fr, ...) -> default region.
// Returns null when none of these apply so voiceLang() can decide.
const LANG2_FROM_PREFIX: Record<string, string> = {
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-GB',
  gb: 'en-GB',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  hi: 'hi-IN',
  it: 'it-IT',
  ja: 'ja-JP',
  nl: 'nl-NL',
  pt: 'pt-BR',
  zh: 'zh-CN',
};

const voiceLangFromTag = (voiceId: string): string | null => {
  const leading = voiceId.split(/[:_]/)[0] ?? '';
  // `en-US-Harper:MAI-Voice-2` -> leading "en-US" region tag.
  const region = leading.match(/^([a-z]{2,3})-([A-Z]{2})/);
  if (region) return `${region[1]}-${region[2]}`;
  // Deepgram-style trailing language suffix: `flux-alexis-en`, `aura-2-thalia-en`,
  // `aura-2-agathe-fr`, `aura-2-aurelia-de`, `aura-2-livia-it`, `aura-2-daphne-nl`.
  const trailing = voiceId.match(/-([a-z]{2,3})$/);
  if (trailing) {
    const t = trailing[1]!;
    if (LANG2_FROM_PREFIX[t]) return LANG2_FROM_PREFIX[t];
    if (t === 'us') return 'en-US';
  }
  // `en_paul_sad` / `gb_oliver_neutral`: a known 2-letter language prefix.
  const langPrefix = leading.split(/[_-]/)[0]!;
  if (LANG2_FROM_PREFIX[langPrefix]) return LANG2_FROM_PREFIX[langPrefix];
  return null;
};

const voiceName = (voiceId: string): string =>
  voiceId
    .replace(/^[a-z]+_/, '')
    .replace(/[:_]/g, ' ')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || voiceId;

/** Turn a bare voice id into a TTSVoice, tagging language as best we can. */
const toVoice = (voiceId: string, staticMeta?: { lang?: string }): TTSVoice => {
  const fromTag = voiceLangFromTag(voiceId);
  const lang = staticMeta?.lang ?? fromTag ?? voiceLang(voiceId);
  return { id: voiceId, name: voiceName(voiceId), lang };
};

/** HTTP helper with a short timeout and optional outer-signal chaining. */
const withTimeout = (signal?: AbortSignal): { signal: AbortSignal; clear: () => void } => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Timeout')), 5000);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onOuterAbort);
    },
  };
};

/**
 * Resolve the absolute API root for a config under a given URL style.
 * - 'api-v1'   baseUrl already ends in /v1 (OpenAI, OpenRouter) — used as-is.
 * - 'root-v1'  baseUrl is a service root — append /v1.
 * - 'none'     no versioned root (Sarvam) — used as-is (Sarvam engine).
 */
export const resolveApiRoot = (baseUrl: string, style: TTSUrlStyle): string => {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (style === 'root-v1') return `${normalized}/v1`;
  return normalized;
};

export class OpenAISpeechProvider implements SpeechProvider {
  readonly id: string;
  readonly label: string;
  readonly fallbackVoiceId = '';
  readonly cacheable = false;

  #config: TTSProviderConfig;
  #preset: TTSProviderPreset;
  #voices: TTSVoice[] = [];
  // Voice map keyed by model id for `supported-voices` presets (OpenRouter):
  // each model advertises its own voices on the models list.
  #modelVoices = new Map<string, TTSVoice[]>();
  // Model list, captured during init() so voice resolution can read it.
  #models: string[] = [];
  // In-flight dedup: the buffered client prefetches the first sentences and
  // the playback scheduler then requests the same text again. Deduping by
  // request key means the second caller awaits the first fetch instead of
  // doubling the load on the engine (see BufferedTTSClient.#preload).
  #inflight = new Map<string, Promise<SpeechSynthesisResult>>();

  constructor(config: TTSProviderConfig) {
    this.#config = config;
    this.#preset = getPreset(config.preset);
    this.id = `tts-${this.#preset.engine}-${config.id}`;
    this.label = config.name || this.#preset.defaultName || 'Custom TTS';
  }

  get config(): TTSProviderConfig {
    return this.#config;
  }

  /** True when the base URL points at OpenAI's own API. */
  get #isOpenAIHost(): boolean {
    const { baseUrl } = this.#config;
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      return host === 'api.openai.com' || host.endsWith('.openai.com');
    } catch {
      return false;
    }
  }

  /**
   * URL style effective for this config. Legacy `custom` providers predate
   * presets: they entered a service ROOT (api.openai.com, a Kokoro host) and
   * the engine appended /v1. Keep that for custom preset-less configs, and for
   * any custom config pointing at OpenAI's root (which is root-v1). A custom
   * config whose URL already ends in /v1 stays api-v1.
   */
  get #effectiveUrlStyle(): TTSUrlStyle {
    if (this.#preset.id !== 'custom') return this.#preset.urlStyle;
    if (this.#isOpenAIHost) return 'root-v1';
    return /\/v\d+$/i.test(this.#config.baseUrl.trim()) ? 'api-v1' : 'root-v1';
  }

  /** Resolved model id: explicit config model, else preset/host default. */
  get #resolvedModel(): string {
    const explicit = this.#config.model?.trim();
    if (explicit) return explicit;
    if (this.#preset.defaultModel) return this.#preset.defaultModel;
    // Backward-compatible host default for legacy custom OpenAI configs.
    if (this.#isOpenAIHost) return 'tts-1';
    // Legacy `custom` (preset-less) endpoints default to kokoro; any other
    // preset with no default (Azure deployment names) and no configured model
    // returns '' so the caller surfaces the requirement rather than silently
    // sending a wrong model.
    if (this.#preset.id === 'custom') {
      return this.#models[0] || DEFAULT_MODEL;
    }
    return this.#models[0] || '';
  }

  /** Absolute API root (per preset URL style). */
  get #apiRoot(): string {
    return resolveApiRoot(this.#config.baseUrl, this.#effectiveUrlStyle);
  }

  /** Auth headers per the preset descriptor. */
  #authHeaders(): Record<string, string> {
    const { apiKey } = this.#config;
    if (!apiKey) return {};
    const { header, prefix } = this.#preset.auth;
    return prefix ? { [header]: `${prefix} ${apiKey}` } : { [header]: apiKey };
  }

  // Probe the endpoint and cache the voice list. False means the engine is
  // unreachable (its voices render disabled in the picker).
  async init(): Promise<boolean> {
    try {
      if (!this.#preset.modelsDisabled) {
        await this.#fetchModels();
      }
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

  /** Absolute URL for the speech endpoint, honoring path template + api-version. */
  #speechUrl(model: string): string {
    let path =
      this.#preset.speechPathTemplate?.replace('{model}', encodeURIComponent(model)) ||
      '/audio/speech';
    if (!path.startsWith('/')) path = `/${path}`;
    const apiVersion = this.#preset.apiVersion;
    const base = this.#preset.urlStyle === 'none' ? this.#config.baseUrl : this.#apiRoot;
    const separator = path.includes('?') ? '&' : '?';
    return `${base.replace(/\/+$/, '')}${path}${apiVersion ? `${separator}api-version=${encodeURIComponent(apiVersion)}` : ''}`;
  }

  async #synthesizeOnce(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const model = this.#resolvedModel;
    let response: Response;
    try {
      // No artificial timeout here: long sentences can legitimately take a
      // while to synthesize. The caller's AbortSignal is the only thing that
      // cancels an in-flight request.
      response = await fetch(this.#speechUrl(model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/*',
          ...this.#authHeaders(),
        },
        body: JSON.stringify({
          model,
          input: req.text,
          voice: req.voice,
          // Rate is a playout concern; keep the synthesized audio
          // rate-independent (and therefore cacheable downstream).
          speed: 1.0,
          // Preset extras (response_format etc.).
          ...this.#preset.speechExtras,
        }),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new Error(`TTS request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = `TTS API error ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      // The engine answered without audio: retrying the same sentence
      // cannot succeed, so classify it as permanent for the skip path.
      throw new SpeechSynthesisPermanentError(message, { cause: response });
    }

    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      throw new SpeechSynthesisPermanentError('TTS returned no audio data');
    }

    // No word-boundary timings from OpenAI-compatible engines: sentence
    // highlighting is the designed degradation.
    return { audio, boundaries: [] };
  }

  /**
   * Fetch the model list. When the preset's models list is filtered by speech
   * modality (OpenRouter: `?output_modalities=speech`), only TTS-capable
   * models come back, and each may carry `supported_voices` that becomes the
   * voice source for `supported-voices` presets.
   */
  async #fetchModels(): Promise<string[]> {
    if (this.#preset.modelsDisabled) return [];
    const { signal, clear } = withTimeout();
    try {
      const url =
        this.#preset.modelsFilter === 'speech'
          ? `${this.#apiRoot}/models?output_modalities=speech`
          : `${this.#apiRoot}/models`;
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          ...this.#authHeaders(),
        },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as {
        data?: { id: string; supported_voices?: string[] | null }[];
      };
      this.#models = data.data?.map((m) => m.id) ?? [];
      if (this.#preset.voiceSource === 'supported-voices') {
        for (const m of data.data ?? []) {
          const rawVoices = m.supported_voices;
          if (!Array.isArray(rawVoices)) continue;
          this.#modelVoices.set(
            m.id,
            rawVoices.map((v) => toVoice(v)),
          );
        }
      }
      return this.#models;
    } finally {
      clear();
    }
  }

  /** Voice list for the configured model under a `supported-voices` preset. */
  #voicesForModel(): TTSVoice[] {
    const model = this.#resolvedModel;
    const modelVoices = this.#modelVoices.get(model);
    const voices = modelVoices ?? [];
    // A model with supported_voices:null (voice-cloning only, e.g. some Fish
    // Audio / MiniMax models) has no enumerable voices. If the user typed an
    // explicit voice id in the config, surface it as the single selectable
    // voice so the picker isn't empty.
    const explicit = this.#config.voice?.trim();
    if (explicit && !voices.some((v) => v.id === explicit)) {
      return [toVoice(explicit)].concat(voices);
    }
    return voices;
  }

  async #fetchVoices(): Promise<TTSVoice[]> {
    // 1. Preset static list (OpenAI / Azure standard voices).
    if (this.#preset.voiceSource === 'static') {
      const meta = this.#preset.staticVoiceMeta ?? [];
      return meta.length > 0
        ? meta.map((m) => ({ id: m.id, name: m.name, lang: m.lang ?? 'en' }))
        : OPENAI_STANDARD_VOICES.map((v) => ({ id: v, name: voiceName(v), lang: 'en-US' }));
    }

    // 2. Voices come from the selected model's supported_voices (OpenRouter).
    if (this.#preset.voiceSource === 'supported-voices') {
      // Ensure the models list (and therefore the model→voices map) is loaded.
      if (this.#modelVoices.size === 0 && this.#models.length === 0) {
        await this.#fetchModels().catch(() => {});
      }
      return this.#voicesForModel();
    }

    // 3. Voices from an `/audio/voices` endpoint (Kokoro-FastAPI, custom).
    const authHeaders = this.#authHeaders();
    const { signal, clear } = withTimeout();
    try {
      const response = await fetch(`${this.#apiRoot}/audio/voices`, {
        headers: { Accept: 'application/json', ...authHeaders },
        signal,
      });
      if (response.ok) {
        const data = (await response.json()) as
          | { voices?: (string | { id?: string; name?: string; language?: string })[] }
          | string[];
        const raw = Array.isArray(data) ? data : (data.voices ?? []);
        return raw.map((voice) => {
          if (typeof voice === 'string') return toVoice(voice);
          const id = voice.id ?? '';
          // Structured voices can carry an explicit language/name; prefer
          // them, then fall back to the id-based inference.
          return {
            id,
            name: voice.name || voiceName(id),
            lang: voice.language ?? voiceLangFromTag(id) ?? voiceLang(id),
          };
        });
      }
      // 404: no /audio/voices endpoint (e.g. real OpenAI behind a custom
      // base URL). Fall back to OpenAI's documented TTS voice set.
      return OPENAI_STANDARD_VOICES.map((voice) => ({
        id: voice,
        name: voiceName(voice),
        lang: 'en-US',
      }));
    } finally {
      clear();
    }
  }
}
