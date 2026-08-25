import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTTSProviderStore } from '@/store/useTTSProviderStore';

/**
 * Hydrate the TTS-provider store from persisted `settings.ttsProviders`
 * + localStorage.
 *
 * The reader constructs a TTSController per book open (which reads the
 * store), and `useReplicaPull` hydrates it during a sync — but that pull
 * is gated on a signed-in user. Without this hook, opening Settings →
 * TTS → Custom Providers straight from the library (no book opened, no
 * account) leaves the store empty, so configured providers vanish from
 * the panel after an app restart until a book is opened. Mount this on
 * the library page so the panel always sees the persisted providers.
 */
export const useTTSProviders = () => {
  const { envConfig, appService } = useEnv();
  const { loadTTSProviders } = useTTSProviderStore();

  useEffect(() => {
    if (!appService) return;
    void loadTTSProviders(envConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService, envConfig]);
};
