// TTS provider presets. A preset is a first-class, provider-specific recipe
// describing HOW to talk to a given service — the wire style, URL layout,
// model/voice discovery, auth, and synthesis extras — so the engine layer can
// stay generic while each preset adapts behaviour at runtime.
//
// Two engine kinds exist today:
//   - 'openai': any endpoint speaking the OpenAI TTS wire format
//       POST {base}/.../audio/speech  { model, input, voice, response_format }
//     plus a models list and (optionally) a voices list. OpenAI itself,
//     OpenRouter, Azure OpenAI, Kokoro-FastAPI and countless self-hosted
//     `/v1/audio/speech` services all speak it.
//   - 'sarvam': Sarvam AI's native REST contract — a *different* wire format
//     (base64 audio in a JSON envelope, `api-subscription-key` auth, BCP-47
//     language codes) that has no OpenAI-compatible SDK. It is the proof that
//     the registry generalizes to ANY HTTP endpoint, not just OpenAI-shaped
//     ones.
//
// The `preset` a user picks is stored on the provider config. The matching
// descriptor here drives the engine (defaults, model filter, voice source,
// auth header). A 'custom' preset exists so any totally-custom, fully
// OpenAI-compatible endpoint can still be entered by hand (the current
// free-form behaviour).

export type TTSPresetId = 'openai' | 'openrouter' | 'azure' | 'kokoro' | 'sarvam' | 'custom';

/** How the base URL composes with the versioned API path. */
export type TTSUrlStyle =
  /** baseUrl already ends in /v1 (OpenAI, OpenRouter): join `/v1/...` after it. */
  | 'api-v1'
  /** baseUrl is the service root (Kokoro local, Azure openai resource): append `/v1`. */
  | 'root-v1'
  /** The engine builds its own full path; no /v1 involved (Sarvam REST). */
  | 'none';

/** Where a preset gets its voice list from. */
export type TTSVoiceSource =
  /** GET {base}/audio/voices (Kokoro-FastAPI). */
  | 'audio-voices'
  /** Each model carries its own `supported_voices` (OpenRouter); use the selected model's. */
  | 'supported-voices'
  /** A fixed list shipped with the preset (OpenAI standard voices). */
  | 'static'
  /** Voices come from the model itself with no separate fetch (Sarvam speakers). */
  | 'static-speakers';

/** Engine discriminator — each value maps to one SpeechProvider implementation. */
export type TTSEngineKind = 'openai' | 'sarvam';

export interface TTSProviderPreset {
  readonly id: TTSPresetId;
  /** i18n key or human label for the preset dropdown. */
  readonly label: string;
  /** Which SpeechProvider implementation serves this preset. */
  readonly engine: TTSEngineKind;
  /** Pre-filled base URL when the preset is chosen. */
  readonly defaultBaseUrl: string;
  /** Pre-filled display name when the preset is chosen ('' → caller derives). */
  readonly defaultName?: string;
  /** Default model id when the user leaves model blank. */
  readonly defaultModel?: string;
  /** Whether an API key/subscription key is required to synthesize. */
  readonly requiresKey: boolean;
  /**
   * Auth: header name + scheme prefix. OpenAI-style uses
   * `Authorization: Bearer <key>`; Sarvam uses `api-subscription-key: <key>`.
   */
  readonly auth: { header: string; prefix?: string };
  /** URL layout: how baseUrl relates to the /v1 (or non-versioned) API path. */
  readonly urlStyle: TTSUrlStyle;
  /**
   * Optional speech path template (relative to the API root) for endpoints
   * whose audio path isn't the plain `audio/speech` under the API root.
   * Azure OpenAI, for example, keyed by deployment:
   *   `/deployments/{model}/audio/speech`. `{model}` is substituted at
   *   request time. Defaults to `/audio/speech`.
   */
  readonly speechPathTemplate?: string;
  /**
   * Azure OpenAI needs an `api-version` query parameter on every request;
   * set to a supported version string to add it automatically.
   */
  readonly apiVersion?: string;
  /**
   * Some endpoints expose no model list to probe (Azure OpenAI has no bare
   * `/models` under the deployment model). When true, init()/Test skip the
   * models fetch and don't require a model list to succeed.
   */
  readonly modelsDisabled?: boolean;
  /** When set, the models list call is filtered by this output modality. */
  readonly modelsFilter?: 'speech';
  /** Voice-list strategy (see TTSVoiceSource). */
  readonly voiceSource: TTSVoiceSource;
  /** Static voice ids for `voiceSource: 'static'` / `'static-speakers'`. */
  readonly staticVoices?: string[];
  /**
   * Static voice id → TTSVoice metadata for static/static-speakers presets.
   * `lang` is optional: some engines (Sarvam) are language-agnostic — the
   * provider re-tags every speaker with the user's configured language.
   */
  readonly staticVoiceMeta?: { id: string; name: string; lang?: string }[];
  /** Synthesis body extras (merged into the OpenAI speech body). */
  readonly speechExtras?: Record<string, unknown>;
  /** Where the user obtains an API key (shown as a link in the UI). */
  readonly getKeyUrl?: string;
  /** Short hint shown under the preset in the UI (i18n key). */
  readonly description?: string;
}

const OPENAI_VOICES: { id: string; name: string; lang: string }[] = [
  { id: 'alloy', name: 'Alloy', lang: 'en-US' },
  { id: 'echo', name: 'Echo', lang: 'en-US' },
  { id: 'fable', name: 'Fable', lang: 'en-US' },
  { id: 'onyx', name: 'Onyx', lang: 'en-US' },
  { id: 'nova', name: 'Nova', lang: 'en-US' },
  { id: 'shimmer', name: 'Shimmer', lang: 'en-US' },
];

// Sarvam bulbul:v3 speaker catalog (exact, case-sensitive API ids). Sarvam
// does not expose per-speaker language metadata — any speaker can synthesize
// any supported `language_code`, so the `lang` field here is only a fallback
// default; the Sarvam provider re-tags voices with the provider's configured
// language at runtime (see sarvam.ts). bulbul:v2 has its own smaller set.
const SARVAM_V3_SPEAKERS: { id: string; name: string; lang: string }[] = [
  { id: 'shubh', name: 'Shubh (default)', lang: 'hi' },
  { id: 'aditya', name: 'Aditya', lang: 'hi' },
  { id: 'ritu', name: 'Ritu', lang: 'hi' },
  { id: 'priya', name: 'Priya', lang: 'hi' },
  { id: 'neha', name: 'Neha', lang: 'hi' },
  { id: 'rahul', name: 'Rahul', lang: 'hi' },
  { id: 'pooja', name: 'Pooja', lang: 'hi' },
  { id: 'rohan', name: 'Rohan', lang: 'hi' },
  { id: 'simran', name: 'Simran', lang: 'hi' },
  { id: 'kavya', name: 'Kavya', lang: 'hi' },
  { id: 'amit', name: 'Amit', lang: 'hi' },
  { id: 'dev', name: 'Dev', lang: 'hi' },
  { id: 'ishita', name: 'Ishita', lang: 'hi' },
  { id: 'shreya', name: 'Shreya', lang: 'hi' },
  { id: 'ratan', name: 'Ratan', lang: 'hi' },
  { id: 'varun', name: 'Varun', lang: 'hi' },
  { id: 'manan', name: 'Manan', lang: 'hi' },
  { id: 'sumit', name: 'Sumit', lang: 'hi' },
  { id: 'roopa', name: 'Roopa', lang: 'hi' },
  { id: 'kabir', name: 'Kabir', lang: 'hi' },
  { id: 'aayan', name: 'Aayan', lang: 'hi' },
  { id: 'ashutosh', name: 'Ashutosh', lang: 'hi' },
  { id: 'advait', name: 'Advait', lang: 'hi' },
  { id: 'anand', name: 'Anand', lang: 'hi' },
  { id: 'tanya', name: 'Tanya', lang: 'hi' },
  { id: 'tarun', name: 'Tarun', lang: 'hi' },
  { id: 'sunny', name: 'Sunny', lang: 'hi' },
  { id: 'mani', name: 'Mani', lang: 'hi' },
  { id: 'gokul', name: 'Gokul', lang: 'hi' },
  { id: 'vijay', name: 'Vijay', lang: 'hi' },
  { id: 'shruti', name: 'Shruti', lang: 'hi' },
  { id: 'suhani', name: 'Suhani', lang: 'hi' },
  { id: 'mohit', name: 'Mohit', lang: 'hi' },
  { id: 'kavitha', name: 'Kavitha', lang: 'hi' },
  { id: 'rehan', name: 'Rehan', lang: 'hi' },
  { id: 'soham', name: 'Soham', lang: 'hi' },
  { id: 'rupali', name: 'Rupali', lang: 'hi' },
];

const SARVAM_V2_SPEAKERS: { id: string; name: string; lang: string }[] = [
  { id: 'anushka', name: 'Anushka (default)', lang: 'hi' },
  { id: 'manisha', name: 'Manisha', lang: 'hi' },
  { id: 'vidya', name: 'Vidya', lang: 'hi' },
  { id: 'arya', name: 'Arya', lang: 'hi' },
  { id: 'abhilash', name: 'Abhilash', lang: 'hi' },
  { id: 'karun', name: 'Karun', lang: 'hi' },
  { id: 'hitesh', name: 'Hitesh', lang: 'hi' },
];

export const TTS_PRESETS: Record<TTSPresetId, TTSProviderPreset> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    engine: 'openai',
    defaultName: 'OpenAI',
    // OpenAI's public endpoint already includes /v1.
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'tts-1',
    requiresKey: true,
    auth: { header: 'Authorization', prefix: 'Bearer' },
    urlStyle: 'api-v1',
    voiceSource: 'static',
    staticVoiceMeta: OPENAI_VOICES,
    speechExtras: { response_format: 'mp3' },
    getKeyUrl: 'https://platform.openai.com/api-keys',
    description:
      'OpenAI\u2019s hosted TTS (tts-1 / gpt-4o-mini-tts). Uses the standard alloy/echo/... voices.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    engine: 'openai',
    defaultName: 'OpenRouter',
    // OpenRouter's API root is /api/v1 (the models list lives at
    // /api/v1/models, NOT /v1/models).
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    auth: { header: 'Authorization', prefix: 'Bearer' },
    urlStyle: 'api-v1',
    modelsFilter: 'speech',
    // Voices come from each model's own supported_voices, so no static list.
    voiceSource: 'supported-voices',
    speechExtras: { response_format: 'mp3' },
    getKeyUrl: 'https://openrouter.ai/keys',
    description:
      'Many TTS models in one API. Models with a voice list show their voices; voice-cloning models let you enter a voice id manually.',
  },
  azure: {
    id: 'azure',
    label: 'Azure OpenAI',
    engine: 'openai',
    defaultName: 'Azure OpenAI',
    // Azure OpenAI data-plane root for audio inference. The `{model}` in the
    // speech path is the *deployment name* the user must type (no default).
    defaultBaseUrl: 'https://RESOURCE.openai.azure.com/openai',
    defaultModel: '',
    requiresKey: true,
    auth: { header: 'api-key' },
    urlStyle: 'none',
    // Azure keys audio by deployment: {base}/deployments/{model}/audio/speech
    speechPathTemplate: '/deployments/{model}/audio/speech',
    apiVersion: '2024-10-21',
    // Azure OpenAI has no bare `/models` probe usable the OpenAI way.
    modelsDisabled: true,
    voiceSource: 'static',
    staticVoiceMeta: OPENAI_VOICES,
    speechExtras: { response_format: 'mp3' },
    description:
      'Azure OpenAI audio. Replace RESOURCE in the base URL and enter your deployment name as the model.',
  },
  kokoro: {
    id: 'kokoro',
    label: 'Kokoro (Local)',
    engine: 'openai',
    defaultName: 'Kokoro',
    defaultBaseUrl: 'http://localhost:8880',
    defaultModel: 'kokoro',
    requiresKey: false,
    auth: { header: 'Authorization', prefix: 'Bearer' },
    urlStyle: 'root-v1',
    voiceSource: 'audio-voices',
    speechExtras: { response_format: 'mp3' },
    description:
      'Local Kokoro-FastAPI server (or any /v1/audio/speech server on your network). No API key needed.',
  },
  sarvam: {
    id: 'sarvam',
    label: 'Sarvam AI',
    engine: 'sarvam',
    defaultName: 'Sarvam AI',
    defaultBaseUrl: 'https://api.sarvam.ai',
    defaultModel: 'bulbul:v3',
    requiresKey: true,
    auth: { header: 'api-subscription-key' },
    urlStyle: 'none',
    voiceSource: 'static-speakers',
    staticVoiceMeta: SARVAM_V3_SPEAKERS,
    // Sarvam's REST contract uses `pace` for speed; OpenAI-compatible uses
    // `speed`. The Sarvam engine maps rate into `pace` itself, so no extras
    // here beyond requesting a decodable codec.
    getKeyUrl: 'https://dashboard.sarvam.ai',
    description:
      'Indic + English voices via Sarvam\u2019s own REST API (bulbul). No OpenAI SDK needed.',
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    engine: 'openai',
    defaultBaseUrl: '',
    requiresKey: false,
    auth: { header: 'Authorization', prefix: 'Bearer' },
    urlStyle: 'root-v1',
    voiceSource: 'audio-voices',
    description:
      'Any endpoint speaking the OpenAI-compatible wire format: GET /models, GET /audio/voices, POST /audio/speech.',
  },
};

/** Speakers for a Sarvam model id. Falls back to v3 when unknown. */
export const sarvamSpeakersForModel = (model: string): TTSProviderPreset['staticVoiceMeta'] => {
  if (model === 'bulbul:v2') return SARVAM_V2_SPEAKERS;
  return SARVAM_V3_SPEAKERS;
};

/** Ordered list for the preset dropdown (custom last). */
export const TTS_PRESET_ORDER: TTSPresetId[] = [
  'openai',
  'openrouter',
  'azure',
  'kokoro',
  'sarvam',
  'custom',
];

export const getPreset = (id?: TTSPresetId | null): TTSProviderPreset =>
  TTS_PRESETS[id && id in TTS_PRESETS ? id : 'custom'];

/** The default preset for a freshly-added (legacy, preset-less) provider. */
export const DEFAULT_PRESET_ID: TTSPresetId = 'custom';
