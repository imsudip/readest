// Sarvam AI TTS as a SpeechProvider. Sarvam's REST contract is a *different*
// wire format from OpenAI — no OpenAI-compatible SDK:
//   POST {baseUrl}/text-to-speech
//   Header: api-subscription-key: <key>
//   Body:   { text, language_code, speaker, model, pace, output_audio_codec }
//   Response: JSON { request_id, audios: [ <base64-encoded WAV> ] }
//
// There is no models list (bulbul:v2 / bulbul:v3 are static), and no
// `/audio/voices` endpoint — the speakers are enumerated by the preset
// descriptor (per-model speaker catalogs in providers/presets.ts). Because the
// audio comes back base64-encoded inside JSON (never as a raw audio stream),
// this engine decodes the payload rather than reading a byte body.
//
// Sarvam returns full WAV buffers with no word-boundary timings, so
// `boundaries` is empty — sentence highlighting is the designed degradation
// (same as every cloud TTS engine). `pace` is the speed knob (OpenAI's `speed`
// has no meaning here); rate is a playout concern so it stays 1.0.
//
// Sarvam requires an explicit BCP-47 `language_code` on every request, so the
// provider persists/uses `config.languageCode`; when absent it falls back to
// the request's lang. Sarvam's supported languages are the Indic set
// (bn-IN, en-IN, gu-IN, hi-IN, kn-IN, ml-IN, mr-IN, od-IN, pa-IN, ta-IN,
// te-IN), so the voice picker filters against the reader language.

import type { TTSVoice } from '../types';
import type { TTSProviderConfig } from './openaiConfigStore';
import { getPreset, sarvamSpeakersForModel } from './presets';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

// Map a reader language (any region form) to Sarvam's allowed BCP-47 codes.
// Sarvam only supports the Indic set plus English; anything else falls back
// to hi-IN so synthesis still succeeds rather than 422ing.
const SARVAM_LANG_TO_CODE: Record<string, string> = {
  en: 'en-IN',
  bn: 'bn-IN',
  gu: 'gu-IN',
  hi: 'hi-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  od: 'od-IN',
  pa: 'pa-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};

const toSarvamLangCode = (lang: string): string => {
  const primary = lang.split('-')[0]!.toLowerCase();
  return SARVAM_LANG_TO_CODE[primary] ?? 'hi-IN';
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Return the underlying buffer copy (atob may give an odd length; we
  // deliberately slice a fresh copy so decodeAudioData never sees a
  // detached/short view).
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const DEFAULT_MODEL = 'bulbul:v3';

export class SarvamSpeechProvider implements SpeechProvider {
  readonly id: string;
  readonly label: string;
  readonly fallbackVoiceId = '';
  readonly cacheable = false;

  #config: TTSProviderConfig;
  #preset: ReturnType<typeof getPreset>;
  #voices: TTSVoice[] = [];
  #inflight = new Map<string, Promise<SpeechSynthesisResult>>();

  constructor(config: TTSProviderConfig) {
    this.#config = config;
    this.#preset = getPreset(config.preset);
    this.id = `tts-sarvam-${config.id}`;
    this.label = config.name || 'Sarvam AI';
  }

  get config(): TTSProviderConfig {
    return this.#config;
  }

  get #resolvedModel(): string {
    return this.#config.model?.trim() || this.#preset.defaultModel || DEFAULT_MODEL;
  }

  // Voices = static speakers for the configured model (bulbul:v3 by default).
  // Voices are enumerated once per model and cached.
  async init(): Promise<boolean> {
    // No network probe exists for Sarvam short of a full synthesize; treat the
    // engine as available when a key is present. If the key is missing the
    // picker will show the group disabled (BufferedTTSClient sets
    // voice.disabled = !initialized).
    const available = !!this.#config.apiKey;
    if (available) {
      this.#voices = this.#staticVoices();
    }
    return available;
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    if (this.#voices.length === 0) {
      this.#voices = this.#staticVoices();
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
    const { apiKey } = this.#config;
    if (!apiKey) {
      throw new SpeechSynthesisPermanentError('Sarvam AI requires an API key');
    }
    let response: Response;
    try {
      const body: Record<string, unknown> = {
        text: req.text,
        language_code: this.#config.languageCode || toSarvamLangCode(req.lang),
        // Sarvam calls the speed knob `pace`; rate is a playout concern, so we
        // always request 1.0 and let the client time-stretch.
        pace: 1.0,
        model: this.#resolvedModel,
        output_audio_codec: 'wav',
      };
      if (req.voice) body['speaker'] = req.voice;

      // No artificial timeout: a full paragraph can take a while to render.
      // The caller's AbortSignal is the only cancellation.
      response = await fetch(`${this.#config.baseUrl.replace(/\/+$/, '')}/text-to-speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'api-subscription-key': apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new Error(
        `Sarvam TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = `Sarvam TTS API error ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      throw new SpeechSynthesisPermanentError(message, { cause: response });
    }

    // Sarvam returns JSON with base64 WAV audio, never a raw audio stream.
    const json = (await response.json()) as { audios?: string[]; request_id?: string | null };
    const firstAudio = Array.isArray(json.audios) ? json.audios[0] : undefined;
    if (!firstAudio) {
      throw new SpeechSynthesisPermanentError('Sarvam TTS returned no audio data');
    }

    let audio: ArrayBuffer;
    try {
      audio = base64ToArrayBuffer(firstAudio);
    } catch {
      throw new SpeechSynthesisPermanentError('Sarvam TTS returned malformed audio data');
    }
    if (audio.byteLength === 0) {
      throw new SpeechSynthesisPermanentError('Sarvam TTS returned no audio data');
    }

    // No word-boundary timings: sentence highlighting is the degradation.
    return { audio, boundaries: [] };
  }

  #staticVoices(): TTSVoice[] {
    const meta = sarvamSpeakersForModel(this.#resolvedModel) ?? [];
    // Sarvam speakers are language-agnostic: any speaker can synthesize any
    // supported language_code. Tag every voice with the provider's configured
    // language (defaulting to Hindi) so the picker's isSameLang filter keeps
    // them visible for the language the user actually reads in.
    const primary = this.#config.languageCode
      ? this.#config.languageCode.split('-')[0]!.toLowerCase()
      : 'hi';
    return meta.map((m) => ({ id: m.id, name: m.name, lang: primary }));
  }
}
