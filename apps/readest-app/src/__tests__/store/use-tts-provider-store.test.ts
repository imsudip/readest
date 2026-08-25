import { describe, test, expect, beforeEach, vi } from 'vitest';
import { useTTSProviderStore } from '@/store/useTTSProviderStore';
import { useSettingsStore } from '@/store/settingsStore';
import { computeTTSProviderContentId } from '@/services/sync/adapters/ttsProvider';
import {
  loadProviderConfigs,
  saveProviderConfigs,
} from '@/services/tts/providers/openaiConfigStore';
import type { SystemSettings } from '@/types/settings';
import type { EnvConfigType } from '@/services/environment';

// Replica-publish helpers fan out to the network — stub them so tests
// stay hermetic. We assert they fire for upserts/deletes via spies.
vi.mock('@/services/sync/replicaPublish', () => ({
  publishReplicaUpsert: vi.fn(),
  publishReplicaDelete: vi.fn(),
}));

import { publishReplicaUpsert, publishReplicaDelete } from '@/services/sync/replicaPublish';

// getReplicaPersistEnv drives the auto-persist side channel — keep it
// inert in tests so saveTTSProviders only runs when we call it directly.
vi.mock('@/services/sync/replicaPersist', () => ({
  getReplicaPersistEnv: () => null,
}));

const makeEnvConfig = (): EnvConfigType =>
  ({
    getAppService: vi.fn(),
  }) as unknown as EnvConfigType;

const makeSettings = (overrides: Partial<SystemSettings> = {}): SystemSettings =>
  ({
    ttsProviders: [],
    ...overrides,
  }) as unknown as SystemSettings;

beforeEach(() => {
  localStorage.clear();
  useTTSProviderStore.setState({ providers: [], loading: false });
  useSettingsStore.setState({
    settings: makeSettings(),
    setSettings: (s: SystemSettings) => useSettingsStore.setState({ settings: s }),
    saveSettings: vi.fn(),
  } as unknown as ReturnType<typeof useSettingsStore.getState>);
  vi.clearAllMocks();
});

describe('useTTSProviderStore', () => {
  describe('addProvider', () => {
    test('mints a contentId from the baseUrl when one is not provided', () => {
      const provider = useTTSProviderStore.getState().addProvider({
        name: 'Kokoro',
        baseUrl: 'http://localhost:8880',
        apiKey: 'k',
      });
      expect(provider.contentId).toBe(computeTTSProviderContentId('http://localhost:8880'));
      expect(provider.addedAt).toBeGreaterThan(0);
      expect(provider.id).toBe(provider.contentId);
    });

    test('normalizes baseUrl for contentId (case + trailing slash)', () => {
      const a = useTTSProviderStore.getState().addProvider({
        name: 'A',
        baseUrl: 'http://HOST:8880/',
        apiKey: '',
      });
      const b = useTTSProviderStore.getState().addProvider({
        name: 'B',
        baseUrl: 'http://host:8880',
        apiKey: '',
      });
      expect(a.contentId).toBe(b.contentId);
    });

    test('publishes the upsert via replicaPublish', () => {
      useTTSProviderStore.getState().addProvider({
        name: 'Kokoro',
        baseUrl: 'http://localhost:8880',
        apiKey: 'k',
      });
      expect(publishReplicaUpsert).toHaveBeenCalledTimes(1);
      const [kind] = (publishReplicaUpsert as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(kind).toBe('tts_provider');
    });

    test('persists to localStorage (the TTSController runtime cache)', () => {
      useTTSProviderStore.getState().addProvider({
        name: 'Kokoro',
        baseUrl: 'http://localhost:8880',
        apiKey: 'k',
      });
      expect(loadProviderConfigs()).toHaveLength(1);
      expect(loadProviderConfigs()[0]?.name).toBe('Kokoro');
    });
  });

  describe('updateProvider', () => {
    test('patches fields and republishes', () => {
      const provider = useTTSProviderStore.getState().addProvider({
        name: 'A',
        baseUrl: 'http://a',
        apiKey: '',
      });
      vi.clearAllMocks();
      const updated = useTTSProviderStore.getState().updateProvider(provider.id, {
        model: 'kokoro',
      });
      expect(updated?.model).toBe('kokoro');
      expect(publishReplicaUpsert).toHaveBeenCalledTimes(1);
    });

    test('recomputes contentId when baseUrl changes, keeping a stable row per URL', () => {
      const provider = useTTSProviderStore.getState().addProvider({
        name: 'A',
        baseUrl: 'http://a',
        apiKey: '',
      });
      const updated = useTTSProviderStore.getState().updateProvider(provider.id, {
        baseUrl: 'http://b',
      });
      expect(updated?.contentId).toBe(computeTTSProviderContentId('http://b'));
      expect(updated?.id).toBe(updated?.contentId);
    });
  });

  describe('removeProvider', () => {
    test('soft-deletes and pushes a tombstone', () => {
      const provider = useTTSProviderStore.getState().addProvider({
        name: 'A',
        baseUrl: 'http://a',
        apiKey: '',
      });
      vi.clearAllMocks();
      const removed = useTTSProviderStore.getState().removeProvider(provider.id);
      expect(removed).toBe(true);
      expect(useTTSProviderStore.getState().getAvailableProviders()).toHaveLength(0);
      expect(publishReplicaDelete).toHaveBeenCalledWith('tts_provider', provider.contentId);
    });

    test('re-adding a removed provider revives it under the same contentId', () => {
      const { addProvider, removeProvider, getAvailableProviders } = useTTSProviderStore.getState();
      const provider = addProvider({ name: 'A', baseUrl: 'http://a', apiKey: '' });
      removeProvider(provider.id);
      expect(getAvailableProviders()).toHaveLength(0);
      addProvider({ name: 'A', baseUrl: 'http://a', apiKey: '' });
      expect(getAvailableProviders()).toHaveLength(1);
    });
  });

  describe('applyRemoteProvider', () => {
    test('adds a remote provider to local state and localStorage without republishing', () => {
      const remote = {
        id: computeTTSProviderContentId('http://remote'),
        contentId: computeTTSProviderContentId('http://remote'),
        name: 'Remote',
        baseUrl: 'http://remote',
        apiKey: 'key',
      };
      vi.clearAllMocks();
      useTTSProviderStore.getState().applyRemoteProvider(remote);
      expect(useTTSProviderStore.getState().getAvailableProviders()).toHaveLength(1);
      expect(publishReplicaUpsert).not.toHaveBeenCalled();
      expect(loadProviderConfigs()).toHaveLength(1);
    });

    test('preserves local apiKey when remote arrives without it (undefined)', () => {
      const local = useTTSProviderStore.getState().addProvider({
        name: 'Local',
        baseUrl: 'http://local',
        apiKey: 'local-key',
      });
      useTTSProviderStore.getState().applyRemoteProvider({
        id: local.contentId!,
        contentId: local.contentId,
        name: 'Remote-renamed',
        baseUrl: 'http://local',
        // apiKey omitted — the publishing device didn't sync credentials
        // (locked session or credentials sync off).
      });
      const merged = useTTSProviderStore.getState().findByContentId(local.contentId!);
      expect(merged?.name).toBe('Remote-renamed');
      expect(merged?.apiKey).toBe('local-key');
    });

    test('remote explicit empty apiKey clears the local key', () => {
      const local = useTTSProviderStore.getState().addProvider({
        name: 'Local',
        baseUrl: 'http://local',
        apiKey: 'local-key',
      });
      useTTSProviderStore.getState().applyRemoteProvider({
        id: local.contentId!,
        contentId: local.contentId,
        name: 'Local',
        baseUrl: 'http://local',
        apiKey: '',
      });
      const merged = useTTSProviderStore.getState().findByContentId(local.contentId!);
      expect(merged?.apiKey).toBe('');
    });
  });

  describe('loadTTSProviders / saveTTSProviders', () => {
    test('loadTTSProviders backfills contentIds on legacy entries and publishes them', async () => {
      saveProviderConfigs([
        { id: 'legacy-1', name: 'Legacy', baseUrl: 'http://legacy', apiKey: '' },
      ]);
      const env = makeEnvConfig();
      await useTTSProviderStore.getState().loadTTSProviders(env);
      const providers = useTTSProviderStore.getState().providers;
      expect(providers).toHaveLength(1);
      expect(providers[0]?.contentId).toBe(computeTTSProviderContentId('http://legacy'));
      expect(publishReplicaUpsert).toHaveBeenCalled();
    });

    test('saveTTSProviders strips tombstones and persists to settings + localStorage', async () => {
      const provider = useTTSProviderStore.getState().addProvider({
        name: 'A',
        baseUrl: 'http://a',
        apiKey: '',
      });
      useTTSProviderStore.getState().removeProvider(provider.id);
      const env = makeEnvConfig();
      await useTTSProviderStore.getState().saveTTSProviders(env);
      const settings = useSettingsStore.getState().settings;
      expect(settings.ttsProviders).toHaveLength(0);
      expect(loadProviderConfigs()).toHaveLength(0);
    });
  });
});
