import { create } from 'zustand';
import type { EnvConfigType } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { getReplicaPersistEnv } from '@/services/sync/replicaPersist';
import { publishReplicaDelete, publishReplicaUpsert } from '@/services/sync/replicaPublish';
import {
  computeTTSProviderContentId,
  TTS_PROVIDER_KIND,
} from '@/services/sync/adapters/ttsProvider';
import {
  addProviderConfig,
  loadProviderConfigs,
  removeProviderConfig,
  saveProviderConfigs,
  updateProviderConfig,
  type OpenAITTSProviderConfig,
} from '@/services/tts/providers/openaiConfigStore';

const publishProviderUpsert = (provider: OpenAITTSProviderConfig): void => {
  if (!provider.contentId) return;
  void publishReplicaUpsert(
    TTS_PROVIDER_KIND,
    provider,
    provider.contentId,
    provider.reincarnation,
  );
};

const publishProviderDelete = (contentId: string): void => {
  void publishReplicaDelete(TTS_PROVIDER_KIND, contentId);
};

/**
 * Backfill `contentId` (and `addedAt`) on legacy providers that predate
 * replica sync. Returns the same array reference if no changes were
 * required so callers can cheaply detect a no-op.
 *
 * `addedAt` is assigned per array index so the existing display order
 * survives the migration: index 0 (newest in the legacy array) gets
 * the largest timestamp, index N gets the smallest. The total span is
 * tiny (≤ N ms) so newly-added providers (with `Date.now()`) still
 * sort above the migrated set.
 */
const backfillSyncFields = (providers: OpenAITTSProviderConfig[]): OpenAITTSProviderConfig[] => {
  let mutated = false;
  const baseTime = Date.now();
  const next = providers.map((p, i) => {
    if (p.contentId && p.addedAt !== undefined) return p;
    mutated = true;
    return {
      ...p,
      contentId: p.contentId ?? computeTTSProviderContentId(p.baseUrl),
      addedAt: p.addedAt ?? baseTime - i,
    };
  });
  return mutated ? next : providers;
};

/** Strip tombstoned entries for persistence (mirrors customOPDSStore). */
const liveProviders = (providers: OpenAITTSProviderConfig[]): OpenAITTSProviderConfig[] =>
  providers.filter((p) => !p.deletedAt);

interface TTSProviderStoreState {
  providers: OpenAITTSProviderConfig[];
  loading: boolean;

  /** Visible providers (tombstones filtered out). */
  getAvailableProviders(): OpenAITTSProviderConfig[];
  getProvider(id: string): OpenAITTSProviderConfig | undefined;
  /** Look up by stable cross-device content id. */
  findByContentId(contentId: string): OpenAITTSProviderConfig | undefined;

  /**
   * Add (or revive) a provider. Computes `contentId` from baseUrl if
   * absent and uses it as the local `id` too. Always attaches a
   * reincarnation token so the upsert replaces any server-side tombstone
   * with a fresh row instead of losing to it under remove-wins.
   */
  addProvider(
    input: Omit<OpenAITTSProviderConfig, 'id' | 'contentId'> & { contentId?: string },
  ): OpenAITTSProviderConfig;
  /** Patch a provider's mutable fields. Only the patched fields are republished. */
  updateProvider(
    id: string,
    patch: Partial<Omit<OpenAITTSProviderConfig, 'id' | 'contentId'>>,
  ): OpenAITTSProviderConfig | undefined;
  /** Soft-delete by id; pushes a tombstone if the entry has a contentId. */
  removeProvider(id: string): boolean;

  /**
   * Apply a provider received via replica sync from another device. Same
   * effect on local state as addProvider, but does NOT republish.
   */
  applyRemoteProvider(provider: OpenAITTSProviderConfig): void;
  /** Mirror a server-side tombstone locally without re-publishing. */
  softDeleteByContentId(contentId: string): void;

  /** Hydrate from `settings.ttsProviders` + localStorage. Backfills sync fields if needed. */
  loadTTSProviders(envConfig: EnvConfigType): Promise<void>;
  /** Persist current state back into settings + localStorage. */
  saveTTSProviders(envConfig: EnvConfigType): Promise<void>;
}

export const useTTSProviderStore = create<TTSProviderStoreState>((set, get) => ({
  providers: [],
  loading: false,

  getAvailableProviders: () => get().providers.filter((p) => !p.deletedAt),

  getProvider: (id) => get().providers.find((p) => p.id === id),

  findByContentId: (contentId) =>
    contentId ? get().providers.find((p) => p.contentId === contentId) : undefined,

  addProvider: (input) => {
    const contentId = input.contentId ?? computeTTSProviderContentId(input.baseUrl);
    const existing = get().providers.find((p) => p.contentId === contentId);
    // Always carry a reincarnation token on add so the upsert beats any
    // server tombstone; the token is inert when the row is alive.
    const reincarnation =
      input.reincarnation ?? existing?.reincarnation ?? Math.random().toString(36).slice(2);
    const provider: OpenAITTSProviderConfig = {
      ...input,
      id: contentId,
      contentId,
      addedAt: input.addedAt ?? existing?.addedAt ?? Date.now(),
      deletedAt: undefined,
      reincarnation,
    };
    set((state) => {
      const idx = state.providers.findIndex((p) => p.contentId === contentId);
      const providers =
        idx >= 0
          ? state.providers.map((p, i) => (i === idx ? provider : p))
          : [...state.providers, provider];
      return { providers };
    });
    saveProviderConfigs(liveProviders(get().providers));
    publishProviderUpsert(provider);
    const env = getReplicaPersistEnv();
    if (env) void get().saveTTSProviders(env);
    return provider;
  },

  updateProvider: (id, patch) => {
    let updated: OpenAITTSProviderConfig | undefined;
    set((state) => {
      const idx = state.providers.findIndex((p) => p.id === id);
      if (idx < 0) return state;
      const old = state.providers[idx]!;
      if (old.deletedAt) return state;
      updated = { ...old, ...patch };
      // Recompute contentId only if the baseUrl itself changed; otherwise
      // preserve the existing one so we keep the same server row.
      if (patch.baseUrl && patch.baseUrl !== old.baseUrl) {
        updated.contentId = computeTTSProviderContentId(patch.baseUrl);
        updated.id = updated.contentId;
      }
      return {
        providers: state.providers.map((p, i) => (i === idx ? updated! : p)),
      };
    });
    if (updated) {
      saveProviderConfigs(liveProviders(get().providers));
      publishProviderUpsert(updated);
      const env = getReplicaPersistEnv();
      if (env) void get().saveTTSProviders(env);
    }
    return updated;
  },

  removeProvider: (id) => {
    const provider = get().providers.find((p) => p.id === id);
    if (!provider) return false;
    set((state) => ({
      providers: state.providers.map((p) => (p.id === id ? { ...p, deletedAt: Date.now() } : p)),
    }));
    saveProviderConfigs(liveProviders(get().providers));
    if (provider.contentId) publishProviderDelete(provider.contentId);
    const env = getReplicaPersistEnv();
    if (env) void get().saveTTSProviders(env);
    return true;
  },

  applyRemoteProvider: (provider) => {
    set((state) => {
      const idx = state.providers.findIndex((p) => p.contentId === provider.contentId);
      if (idx >= 0) {
        // Preserve local credentials when remote arrives without them
        // (publishing device hadn't unlocked the CryptoSession, or the
        // local session couldn't decrypt). When remote DOES include
        // decrypted creds, accept them — that's the cross-device sync
        // path enabled by replicaCryptoMiddleware.decryptRowFields.
        // `??` is nullish so an explicit "" from remote (user cleared
        // the apiKey) still overwrites.
        const old = state.providers[idx]!;
        const merged: OpenAITTSProviderConfig = {
          ...provider,
          id: old.id,
          apiKey: provider.apiKey ?? old.apiKey,
          // Preserve the previously-applied cipher fingerprint when the
          // orchestrator didn't attach a fresh one (e.g., row carried no
          // cipher fields, or every decrypt failed). Without this
          // fallback the next pull would treat the row as "never
          // decrypted" and prompt again unnecessarily.
          lastSeenCipher: provider.lastSeenCipher ?? old.lastSeenCipher,
          deletedAt: undefined,
        };
        return { providers: state.providers.map((p, i) => (i === idx ? merged : p)) };
      }
      return { providers: [...state.providers, provider] };
    });
    saveProviderConfigs(liveProviders(get().providers));
    const env = getReplicaPersistEnv();
    if (env) void get().saveTTSProviders(env);
  },

  softDeleteByContentId: (contentId) => {
    const target = get().providers.find((p) => p.contentId === contentId && !p.deletedAt);
    if (!target) return;
    set((state) => ({
      providers: state.providers.map((p) =>
        p.id === target.id ? { ...p, deletedAt: Date.now() } : p,
      ),
    }));
    saveProviderConfigs(liveProviders(get().providers));
    const env = getReplicaPersistEnv();
    if (env) void get().saveTTSProviders(env);
  },

  loadTTSProviders: async (_envConfig) => {
    try {
      const { settings } = useSettingsStore.getState();
      const persisted = settings?.ttsProviders ?? [];
      // localStorage is the runtime cache the TTSController reads; a
      // provider synced in from another device lands there via
      // applyRemoteProvider -> saveProviderConfigs. Prefer the merged
      // union: persisted settings entries + anything in localStorage the
      // settings row hasn't picked up yet (pre-sync legacy configs).
      const cached = loadProviderConfigs();
      const byContentId = new Map<string, OpenAITTSProviderConfig>();
      const seenIds = new Set<string>();
      const merged: OpenAITTSProviderConfig[] = [];
      for (const p of [...persisted, ...cached]) {
        const key = p.contentId ?? p.id;
        if (!key || seenIds.has(key)) continue;
        seenIds.add(key);
        if (p.contentId) byContentId.set(p.contentId, p);
        merged.push(p);
      }
      void byContentId;
      const backfilled = backfillSyncFields(merged);
      set({ providers: backfilled });
      saveProviderConfigs(liveProviders(backfilled));
      // If backfill mutated anything, persist + publish the fresh
      // contentIds so existing providers start syncing on next push.
      if (backfilled !== merged) {
        await get().saveTTSProviders(_envConfig);
        for (const p of backfilled) {
          if (p.contentId && !p.deletedAt) publishProviderUpsert(p);
        }
      }
    } catch (error) {
      console.error('Failed to load TTS providers:', error);
    }
  },

  saveTTSProviders: async (_envConfig) => {
    try {
      const { settings, setSettings, saveSettings } = useSettingsStore.getState();
      const { providers } = get();
      // Tombstoned entries stay in memory so the orchestrator can detect
      // re-import / reincarnation, but they're stripped at the
      // persistence boundary. Carry through every persisted entry the
      // store has no record of (mirrors absServerStore — an in-memory
      // list the store never loaded is NO INFORMATION about the
      // configured providers).
      const live = liveProviders(providers);
      const known = new Set(
        providers.flatMap((p) => [p.id, p.contentId]).filter((v): v is string => !!v),
      );
      const unseen = (settings.ttsProviders ?? []).filter(
        (p) => !known.has(p.id) && !(p.contentId && known.has(p.contentId)),
      );
      settings.ttsProviders = [...live, ...unseen];
      setSettings(settings);
      saveSettings(_envConfig, settings);
      saveProviderConfigs(live);
    } catch (error) {
      console.error('Failed to save TTS providers:', error);
      throw error;
    }
  },
}));

/**
 * Look up a TTS provider by its local id, falling back to persisted
 * settings when the in-memory store hasn't been hydrated yet. Mirrors
 * `findOPDSCatalogByContentId` in customOPDSStore.ts.
 */
export const findTTSProviderById = (id: string): OpenAITTSProviderConfig | undefined => {
  if (!id) return undefined;
  const inMemory = useTTSProviderStore.getState().getProvider(id);
  if (inMemory) return inMemory;
  const persisted = useSettingsStore.getState().settings?.ttsProviders ?? [];
  return persisted.find((p) => p.id === id && !p.deletedAt);
};

/**
 * Look up a TTS provider by its cross-device contentId, falling back to
 * the persisted settings when the in-memory store is empty. The pull-side
 * orchestrator runs at app boot — earlier than the TTS settings mount, so
 * loadTTSProviders hasn't hydrated the zustand store yet. Without the
 * fallback every refresh would treat existing providers as new and double up.
 */
export const findTTSProviderByContentId = (
  contentId: string,
): OpenAITTSProviderConfig | undefined => {
  if (!contentId) return undefined;
  const inMemory = useTTSProviderStore.getState().findByContentId(contentId);
  if (inMemory) return inMemory;
  const persisted = useSettingsStore.getState().settings?.ttsProviders ?? [];
  return persisted.find((p) => p.contentId === contentId && !p.deletedAt);
};

// Re-export for convenience so callers don't import the config-store
// helpers separately when they only need the store.
export { addProviderConfig, loadProviderConfigs, removeProviderConfig, updateProviderConfig };
