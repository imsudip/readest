// Custom TTS provider configs (OpenAI-compatible endpoints), persisted
// locally. Keys stay on-device: they are never uploaded anywhere.

export interface OpenAITTSProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  // Optional model override; when empty the provider's default applies.
  model?: string;
}

const STORAGE_KEY = 'customTTSProviders';

const generateId = (): string =>
  `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const loadProviderConfigs = (): OpenAITTSProviderConfig[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OpenAITTSProviderConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveProviderConfigs = (configs: OpenAITTSProviderConfig[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
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
