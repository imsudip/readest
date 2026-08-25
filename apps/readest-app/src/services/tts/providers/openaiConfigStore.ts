// Custom TTS provider configs (OpenAI-compatible endpoints), persisted
// locally. Keys stay on-device unless the user opts into the
// encrypted-credential sync category (Settings → Manage Sync → Sync
// passphrase): apiKey syncs through the `tts_provider` replica row's
// encryptedFields envelope, never as plaintext.

export interface OpenAITTSProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  /**
   * Bearer token for the endpoint. Required to actually synthesize on a
   * keyed service, but optional on the config object itself: a provider
   * pulled in from another device may arrive without its key when the
   * publishing device hadn't unlocked the encrypted-credential sync
   * (the local plaintext copy is preserved then).
   */
  apiKey?: string;
  // Optional model override; when empty the provider's default applies.
  model?: string;
  /**
   * Stable cross-device identifier derived from the URL. Used as the
   * replica_id so two devices that configure the same endpoint converge
   * to a single row instead of duplicating. Absent on legacy entries
   * created before replica sync shipped — they get backfilled at next
   * save.
   */
  contentId?: string;
  /** Wall-clock ms of first add, used for ordering. */
  addedAt?: number;
  /** Soft-delete timestamp; non-null entries are hidden from the UI. */
  deletedAt?: number;
  /** Reincarnation token (re-add after server tombstone). */
  reincarnation?: string;
  /**
   * Per-field cipher fingerprint of the last successfully-decrypted
   * pull. Maps `fieldName` → cipher's `c` (base64 ciphertext). Sync-only
   * metadata; never surfaced in the TTS UI.
   */
  lastSeenCipher?: Record<string, string>;
}

export const TTS_PROVIDERS_STORAGE_KEY = 'customTTSProviders';

const generateId = (): string =>
  `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const loadProviderConfigs = (): OpenAITTSProviderConfig[] => {
  try {
    const raw = localStorage.getItem(TTS_PROVIDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OpenAITTSProviderConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const saveProviderConfigs = (configs: OpenAITTSProviderConfig[]): void => {
  try {
    localStorage.setItem(TTS_PROVIDERS_STORAGE_KEY, JSON.stringify(configs));
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — ignore.
  }
};

export const addProviderConfig = (
  config: Omit<OpenAITTSProviderConfig, 'id'>,
): OpenAITTSProviderConfig => {
  const withId: OpenAITTSProviderConfig = { ...config, id: generateId() };
  const configs = loadProviderConfigs();
  configs.push(withId);
  saveProviderConfigs(configs);
  return withId;
};

export const updateProviderConfig = (
  id: string,
  patch: Partial<Omit<OpenAITTSProviderConfig, 'id'>>,
): OpenAITTSProviderConfig | undefined => {
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
