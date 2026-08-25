import { describe, test, expect } from 'vitest';
import {
  computeTTSProviderContentId,
  ttsProviderAdapter,
} from '@/services/sync/adapters/ttsProvider';
import type { ReplicaRow } from '@/types/replica';

const makeRow = (fields: Record<string, unknown>): ReplicaRow =>
  ({
    user_id: 'u',
    kind: 'tts_provider',
    replica_id: computeTTSProviderContentId('http://tts'),
    fields_jsonb: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { v, t: '0000000000001-00000000-dev', s: 'dev' }]),
    ),
    manifest_jsonb: null,
    deleted_at_ts: null,
    reincarnation: null,
    updated_at_ts: '0000000000001-00000000-dev',
    schema_version: 1,
  }) as unknown as ReplicaRow;

describe('ttsProviderAdapter', () => {
  test('computes a stable contentId from a normalized baseUrl', () => {
    expect(computeTTSProviderContentId('http://HOST:8880/')).toBe(
      computeTTSProviderContentId('http://host:8880'),
    );
  });

  test('pack emits plaintext fields incl. apiKey (crypto middleware encrypts later)', () => {
    const packed = ttsProviderAdapter.pack({
      id: 'x',
      contentId: 'c',
      name: 'Kokoro',
      baseUrl: 'http://localhost:8880',
      apiKey: 'secret',
      model: 'kokoro',
    });
    expect(packed).toMatchObject({
      name: 'Kokoro',
      baseUrl: 'http://localhost:8880',
      apiKey: 'secret',
      model: 'kokoro',
    });
    expect(ttsProviderAdapter.encryptedFields).toContain('apiKey');
  });

  test('unpackRow builds a provider using contentId as id and drops absent fields', () => {
    const row = makeRow({
      name: 'Kokoro',
      baseUrl: 'http://localhost:8880',
      apiKey: 'secret',
    });
    const provider = ttsProviderAdapter.unpackRow(row, '');
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe(row.replica_id);
    expect(provider?.contentId).toBe(row.replica_id);
    expect(provider?.name).toBe('Kokoro');
    expect(provider?.apiKey).toBe('secret');
    expect(provider?.model).toBeUndefined();
  });

  test('unpackRow returns null when required fields are missing', () => {
    expect(ttsProviderAdapter.unpackRow(makeRow({ name: 'NoUrl' }), '')).toBeNull();
    expect(ttsProviderAdapter.unpackRow(makeRow({ baseUrl: 'http://nourl' }), '')).toBeNull();
  });

  test('unpackRow propagates model, addedAt and reincarnation', () => {
    const row = makeRow({
      name: 'Kokoro',
      baseUrl: 'http://localhost:8880',
      model: 'kokoro',
      addedAt: 123,
    });
    row.reincarnation = 'tok';
    const provider = ttsProviderAdapter.unpackRow(row, '');
    expect(provider?.model).toBe('kokoro');
    expect(provider?.addedAt).toBe(123);
    expect(provider?.reincarnation).toBe('tok');
  });
});
