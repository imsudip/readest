import { md5 } from '@/utils/md5';
import type { OpenAITTSProviderConfig } from '@/services/tts/providers/openaiConfigStore';
import type { ReplicaAdapter } from '@/services/sync/replicaRegistry';
import type { FieldsObject, ReplicaRow } from '@/types/replica';
import { defaultComputeId, unwrap } from './helpers';

export const TTS_PROVIDER_KIND = 'tts_provider';
export const TTS_PROVIDER_SCHEMA_VERSION = 1;

/**
 * Stable cross-device identity for an OpenAI-compatible TTS provider.
 * Two devices that configure the same endpoint converge to a single
 * replica row instead of duplicating. Normalized (trim, strip trailing
 * slash, lower-case) so trailing-slash and case differences don't
 * fragment identity. `name` and `model` are intentionally excluded —
 * they're user labels that may differ per device.
 */
export const computeTTSProviderContentId = (baseUrl: string): string =>
  md5(`tts:${baseUrl.trim().replace(/\/+$/, '').toLowerCase()}`);

interface UnwrappedTTSProviderFields {
  name?: string;
  baseUrl?: string;
  model?: string;
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
  const model = unwrap(fields['model']);
  const addedAt = unwrap(fields['addedAt']);
  const apiKey = unwrap(fields['apiKey']);
  return {
    name: typeof name === 'string' ? name : undefined,
    baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
    model: typeof model === 'string' ? model : undefined,
    addedAt: typeof addedAt === 'number' ? addedAt : undefined,
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
  };
};

export const ttsProviderAdapter: ReplicaAdapter<OpenAITTSProviderConfig> = {
  kind: TTS_PROVIDER_KIND,
  schemaVersion: TTS_PROVIDER_SCHEMA_VERSION,

  pack(provider: OpenAITTSProviderConfig): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      addedAt: provider.addedAt ?? Date.now(),
    };
    if (provider.model !== undefined) fields['model'] = provider.model;
    // Pass the API key as plaintext here — the publish-side crypto
    // middleware (replicaCryptoMiddleware.encryptPackedFields) wraps it
    // in a cipher envelope before it hits fields_jsonb. If the
    // CryptoSession isn't unlocked, the middleware drops it entirely so
    // it never leaks as plaintext.
    if (provider.apiKey !== undefined) fields['apiKey'] = provider.apiKey;
    return fields;
  },

  unpack(fields: Record<string, unknown>): OpenAITTSProviderConfig {
    return {
      id: '',
      name: String(fields['name'] ?? ''),
      baseUrl: String(fields['baseUrl'] ?? ''),
      apiKey: fields['apiKey'] !== undefined ? String(fields['apiKey']) : undefined,
      model: fields['model'] !== undefined ? String(fields['model']) : undefined,
      addedAt: fields['addedAt'] !== undefined ? Number(fields['addedAt']) : undefined,
    };
  },

  computeId: defaultComputeId,

  unpackRow(row: ReplicaRow): OpenAITTSProviderConfig | null {
    const fields = unwrapTTSProviderFields(row.fields_jsonb);
    if (!fields.name || !fields.baseUrl) return null;
    const provider: OpenAITTSProviderConfig = {
      // TTS providers use contentId as their local id — they have no
      // "bundle dir" pointer to disambiguate, and the URL-derived
      // contentId is already a stable cross-device identifier.
      id: row.replica_id,
      contentId: row.replica_id,
      name: fields.name,
      baseUrl: fields.baseUrl,
      apiKey: fields.apiKey,
    };
    if (fields.model !== undefined) provider.model = fields.model;
    if (fields.addedAt !== undefined) provider.addedAt = fields.addedAt;
    if (row.reincarnation) provider.reincarnation = row.reincarnation;
    return provider;
  },

  // Plaintext slot here; the publish/pull middleware handles the
  // crypto round trip. Adapters never see ciphertext.
  encryptedFields: ['apiKey'] as const,

  // No `binary` capability — tts_provider is metadata-only.
};
