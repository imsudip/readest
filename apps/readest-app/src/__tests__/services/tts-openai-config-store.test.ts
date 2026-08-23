import { describe, expect, test, beforeEach } from 'vitest';
import {
  addProviderConfig,
  loadProviderConfigs,
  removeProviderConfig,
  updateProviderConfig,
} from '@/services/tts/providers/openaiConfigStore';

describe('openaiConfigStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('addProviderConfig persists and returns an id', () => {
    const config = addProviderConfig({
      name: 'Kokoro',
      baseUrl: 'http://localhost:8880',
      apiKey: 'k',
    });
    expect(config.id).toBeTruthy();
    expect(loadProviderConfigs()).toHaveLength(1);
    expect(loadProviderConfigs()[0]).toMatchObject({ name: 'Kokoro' });
  });

  test('updateProviderConfig patches fields', () => {
    const config = addProviderConfig({ name: 'A', baseUrl: 'http://a', apiKey: '' });
    const updated = updateProviderConfig(config.id, { model: 'kokoro' });
    expect(updated?.model).toBe('kokoro');
    expect(loadProviderConfigs()[0]?.model).toBe('kokoro');
  });

  test('removeProviderConfig deletes by id', () => {
    const a = addProviderConfig({ name: 'A', baseUrl: 'http://a', apiKey: '' });
    const b = addProviderConfig({ name: 'B', baseUrl: 'http://b', apiKey: '' });
    removeProviderConfig(a.id);
    const remaining = loadProviderConfigs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(b.id);
  });

  test('corrupt storage falls back to empty list', () => {
    localStorage.setItem('customTTSProviders', 'not json');
    expect(loadProviderConfigs()).toEqual([]);
  });
});
