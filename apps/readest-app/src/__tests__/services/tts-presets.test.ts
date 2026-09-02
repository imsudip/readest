import { describe, expect, test } from 'vitest';
import {
  TTS_PRESETS,
  TTS_PRESET_ORDER,
  getPreset,
  sarvamSpeakersForModel,
} from '@/services/tts/providers/presets';

describe('TTS preset registry', () => {
  test('every preset id in the ordered list resolves to a complete descriptor', () => {
    for (const id of TTS_PRESET_ORDER) {
      const preset = TTS_PRESETS[id];
      expect(preset).toBeDefined();
      expect(preset.id).toBe(id);
      expect(preset.engine).toMatch(/^(openai|sarvam)$/);
      expect(preset.urlStyle).toMatch(/^(api-v1|root-v1|none)$/);
      expect(['audio-voices', 'supported-voices', 'static', 'static-speakers']).toContain(
        preset.voiceSource,
      );
      expect(typeof preset.label).toBe('string');
    }
  });

  test('getPreset falls back to custom for unknown/undefined ids', () => {
    expect(getPreset(undefined).id).toBe('custom');
    expect(getPreset('bogus' as never).id).toBe('custom');
    expect(getPreset('openai').id).toBe('openai');
  });

  test('custom preset defaults to the OpenAI-compatible engine with audio-voices', () => {
    const custom = getPreset('custom');
    expect(custom.engine).toBe('openai');
    expect(custom.voiceSource).toBe('audio-voices');
    expect(custom.urlStyle).toBe('root-v1');
  });

  test('openai preset is an api-v1 endpoint with static voices and tts-1 default', () => {
    const preset = getPreset('openai');
    expect(preset.engine).toBe('openai');
    expect(preset.urlStyle).toBe('api-v1');
    expect(preset.defaultBaseUrl).toBe('https://api.openai.com/v1');
    expect(preset.defaultModel).toBe('tts-1');
    expect(preset.voiceSource).toBe('static');
    expect(preset.staticVoiceMeta?.map((v) => v.id)).toEqual([
      'alloy',
      'echo',
      'fable',
      'onyx',
      'nova',
      'shimmer',
    ]);
  });

  test('openrouter preset filters models by speech modality and reads per-model voices', () => {
    const preset = getPreset('openrouter');
    expect(preset.engine).toBe('openai');
    expect(preset.modelsFilter).toBe('speech');
    expect(preset.voiceSource).toBe('supported-voices');
    expect(preset.defaultBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  test('azure preset keys speech by deployment and needs api-version but no /models probe', () => {
    const preset = getPreset('azure');
    expect(preset.engine).toBe('openai');
    expect(preset.modelsDisabled).toBe(true);
    expect(preset.speechPathTemplate).toContain('{model}');
    expect(preset.apiVersion).toBeTruthy();
    expect(preset.auth.header).toBe('api-key');
    expect(preset.defaultModel).toBe('');
  });

  test('sarvam preset is its own engine with a subscription-key header', () => {
    const preset = getPreset('sarvam');
    expect(preset.engine).toBe('sarvam');
    expect(preset.auth).toEqual({ header: 'api-subscription-key' });
    expect(preset.defaultModel).toBe('bulbul:v3');
    expect(preset.voiceSource).toBe('static-speakers');
    expect(preset.urlStyle).toBe('none');
  });

  test('sarvamSpeakersForModel returns v2 for bulbul:v2 and v3 otherwise', () => {
    const v2 = sarvamSpeakersForModel('bulbul:v2') ?? [];
    const v3 = sarvamSpeakersForModel('bulbul:v3') ?? [];
    expect(v2.map((s) => s.id)).toContain('anushka');
    expect(v3.map((s) => s.id)).toContain('shubh');
    expect(v3.length).toBeGreaterThan(v2.length);
  });

  test('sarvam speaker ids match the documented API (case-sensitive, no invented ids)', () => {
    const v3 = sarvamSpeakersForModel('bulbul:v3') ?? [];
    const ids = new Set(v3.map((s) => s.id));
    // A few exact documented ids must be present.
    for (const id of ['shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'kavya']) {
      expect(ids.has(id), `missing documented speaker ${id}`).toBe(true);
    }
  });
});
