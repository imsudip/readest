// Custom TTS provider configs, persisted locally. A provider is either a
// known preset (openai / openrouter / azure / kokoro / sarvam) or a fully
// custom OpenAI-compatible endpoint. Keys stay on-device unless the user opts
// into the encrypted-credential sync category (Settings → Manage Sync → Sync
// passphrase): apiKey syncs through the `tts_provider` replica row's
// encryptedFields envelope, never as plaintext.
//
// The `preset` field records which registry descriptor (providers/presets.ts)
// the provider was created from; the descriptor drives the engine at runtime
// (URL layout, auth header, model filter, voice source). `model` is shared by
// every engine ("which voice model"), and `voice` is the selected voice/speaker.
// Legacy configs created before presets shipped have no `preset` — they behave
// like 'custom'.

import type { TTSPresetId } from './presets';

export interface TTSProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  /**
   * API/subscription key for the endpoint. Required to actually synthesize on
   * a keyed service, but optional on the config object itself: a provider
   * pulled in from another device may arrive without its key when the
   * publishing device hadn't unlocked the encrypted-credential sync (the
   * local plaintext copy is preserved then).
   */
  apiKey?: string;
  /** Which preset recipe this provider follows (drives the engine). */
  preset?: TTSPresetId;
  /**
   * Model / voice-model id. Optional; when empty the preset's default
   * applies (or the endpoint's own default for custom providers).
   */
  model?: string;
  /**
   * The currently-selected voice id. Optional. For most presets voices are
   * discovered at runtime; this is persisted so the reader can restore the
   * user's selection. Not all providers need it persisted (the voice picker
   * already remembers via TTSUtils), but it lets a preset that has no voice
   * list (e.g. voice-cloning models with `supported_voices: null`) still
   * carry an explicit voice id.
   */
  voice?: string;
  /**
   * BCP-47 language code used by engines that require an explicit language on
   * every request (Sarvam). OpenAI-compatible engines infer language from the
   * voice, so this is normally unset.
   */
  languageCode?: string;
  /**
   * Stable cross-device identifier derived from the URL. Used as the
   * replica_id so two devices that configure the same endpoint converge to a
   * single row instead of duplicating. Absent on legacy entries created
   * before replica sync shipped — they get backfilled at next save.
   */
  contentId?: string;
  /** Wall-clock ms of first add, used for ordering. */
  addedAt?: number;
  /** Soft-delete timestamp; non-null entries are hidden from the UI. */
  deletedAt?: number;
  /** Reincarnation token (re-add after server tombstone). */
  reincarnation?: string;
  /**
   * Per-field cipher fingerprint of the last successfully-decrypted pull.
   * Maps `fieldName` → cipher's `c` (base64 ciphertext). Sync-only metadata;
   * never surfaced in the TTS UI.
   */
  lastSeenCipher?: Record<string, string>;
}

// The type was historically named for the OpenAI-compatible engine; keep an
// alias so existing imports keep compiling while the concept generalizes.
/** @deprecated use {@link TTSProviderConfig} */
export type OpenAITTSProviderConfig = TTSProviderConfig;

export const TTS_PROVIDERS_STORAGE_KEY = 'customTTSProviders';

const generateId = (): string =>
  `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const loadProviderConfigs = (): TTSProviderConfig[] => {
  try {
    const raw = localStorage.getItem(TTS_PROVIDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TTSProviderConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const saveProviderConfigs = (configs: TTSProviderConfig[]): void => {
  try {
    localStorage.setItem(TTS_PROVIDERS_STORAGE_KEY, JSON.stringify(configs));
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — ignore.
  }
};

export const addProviderConfig = (config: Omit<TTSProviderConfig, 'id'>): TTSProviderConfig => {
  const withId: TTSProviderConfig = { ...config, id: generateId() };
  const configs = loadProviderConfigs();
  configs.push(withId);
  saveProviderConfigs(configs);
  return withId;
};

export const updateProviderConfig = (
  id: string,
  patch: Partial<Omit<TTSProviderConfig, 'id'>>,
): TTSProviderConfig | undefined => {
  const configs = loadProviderConfigs();
  const idx = configs.findIndex((c) => c.id === id);
  if (idx < 0) return undefined;
  const updated = { ...configs[idx]!, ...patch };
  configs[idx] = updated;
  saveProviderConfigs(configs);
  return updated;
};

export const removeProviderConfig = (id: string): void => {
  const configs = loadProviderConfigs().filter((c) => c.id !== id);
  saveProviderConfigs(configs);
};
