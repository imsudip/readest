import { md5 } from '@/utils/md5';
import type { TTSProviderConfig } from '@/services/tts/providers/openaiConfigStore';
import type { ReplicaAdapter } from '@/services/sync/replicaRegistry';
import type { FieldsObject, ReplicaRow } from '@/types/replica';
import { defaultComputeId, unwrap } from './helpers';

export const TTS_PROVIDER_KIND = 'tts_provider';
export const TTS_PROVIDER_SCHEMA_VERSION = 1;

/**
 * Stable cross-device identity for a custom TTS provider.
 * Two devices that configure the same endpoint converge to a single
 * replica row instead of duplicating. Normalized (trim, strip trailing
 * slash, lower-case) so trailing-slash and case differences don't
 * fragment identity. `name`, `model`, and the other mutable recipe fields
 * are intentionally excluded — they're user labels / tweaks that may
 * differ per device.
 */
export const computeTTSProviderContentId = (baseUrl: string): string =>
  md5(`tts:${baseUrl.trim().replace(/\/+$/, '').toLowerCase()}`);

interface UnwrappedTTSProviderFields {
  name?: string;
  baseUrl?: string;
  preset?: string;
  model?: string;
  voice?: string;
  languageCode?: string;
  addedAt?: number;
  // Crypto middleware decrypted these in place before unpackRow ran
  // (see replicaCryptoMiddleware.decryptRowFields). A missing entry
  // means either the publishing device hadn't unlocked yet or the
  // local CryptoSession couldn't decrypt — local plaintext copy is
  // preserved by useTTSProviderStore.applyRemoteProvider.
  apiKey?: string;
}

const unwrapTTSProviderFields = (fields: FieldsObject): UnwrappedTTSProviderFields => {
  const name = unwrap(fields['name']);
  const baseUrl = unwrap(fields['baseUrl']);
  const preset = unwrap(fields['preset']);
  const model = unwrap(fields['model']);
  const voice = unwrap(fields['voice']);
  const languageCode = unwrap(fields['languageCode']);
  const addedAt = unwrap(fields['addedAt']);
  const apiKey = unwrap(fields['apiKey']);
  return {
    name: typeof name === 'string' ? name : undefined,
    baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
    preset: typeof preset === 'string' ? preset : undefined,
    model: typeof model === 'string' ? model : undefined,
    voice: typeof voice === 'string' ? voice : undefined,
    languageCode: typeof languageCode === 'string' ? languageCode : undefined,
    addedAt: typeof addedAt === 'number' ? addedAt : undefined,
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
  };
};

export const ttsProviderAdapter: ReplicaAdapter<TTSProviderConfig> = {
  kind: TTS_PROVIDER_KIND,
  schemaVersion: TTS_PROVIDER_SCHEMA_VERSION,

  pack(provider: TTSProviderConfig): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      addedAt: provider.addedAt ?? Date.now(),
    };
    if (provider.preset !== undefined) fields['preset'] = provider.preset;
    if (provider.model !== undefined) fields['model'] = provider.model;
    if (provider.voice !== undefined) fields['voice'] = provider.voice;
    if (provider.languageCode !== undefined) fields['languageCode'] = provider.languageCode;
    // Pass the API key as plaintext here — the publish-side crypto
    // middleware (replicaCryptoMiddleware.encryptPackedFields) wraps it
    // in a cipher envelope before it hits fields_jsonb. If the
    // CryptoSession isn't unlocked, the middleware drops it entirely so
    // it never leaks as plaintext.
    if (provider.apiKey !== undefined) fields['apiKey'] = provider.apiKey;
    return fields;
  },

  unpack(fields: Record<string, unknown>): TTSProviderConfig {
    const presetRaw = fields['preset'];
    const preset =
      presetRaw !== undefined ? (String(presetRaw) as TTSProviderConfig['preset']) : undefined;
    return {
      id: '',
      name: String(fields['name'] ?? ''),
      baseUrl: String(fields['baseUrl'] ?? ''),
      apiKey: fields['apiKey'] !== undefined ? String(fields['apiKey']) : undefined,
      preset,
      model: fields['model'] !== undefined ? String(fields['model']) : undefined,
      voice: fields['voice'] !== undefined ? String(fields['voice']) : undefined,
      languageCode:
        fields['languageCode'] !== undefined ? String(fields['languageCode']) : undefined,
      addedAt: fields['addedAt'] !== undefined ? Number(fields['addedAt']) : undefined,
    };
  },

  computeId: defaultComputeId,

  unpackRow(row: ReplicaRow): TTSProviderConfig | null {
    const fields = unwrapTTSProviderFields(row.fields_jsonb);
    if (!fields.name || !fields.baseUrl) return null;
    const provider: TTSProviderConfig = {
      // TTS providers use contentId as their local id — they have no
      // "bundle dir" pointer to disambiguate, and the URL-derived
      // contentId is already a stable cross-device identifier.
      id: row.replica_id,
      contentId: row.replica_id,
      name: fields.name,
      baseUrl: fields.baseUrl,
      apiKey: fields.apiKey,
    };
    if (fields.preset !== undefined) provider.preset = fields.preset as TTSProviderConfig['preset'];
    if (fields.model !== undefined) provider.model = fields.model;
    if (fields.voice !== undefined) provider.voice = fields.voice;
    if (fields.languageCode !== undefined) provider.languageCode = fields.languageCode;
    if (fields.addedAt !== undefined) provider.addedAt = fields.addedAt;
    if (row.reincarnation) provider.reincarnation = row.reincarnation;
    return provider;
  },

  // Plaintext slot here; the publish/pull middleware handles the
  // crypto round trip. Adapters never see ciphertext.
  encryptedFields: ['apiKey'] as const,

  // No `binary` capability — tts_provider is metadata-only.
};
