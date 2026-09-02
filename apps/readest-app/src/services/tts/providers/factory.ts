// SpeechProvider factory: dispatch a provider config to the engine that
// serves its preset. Adding a new provider engine is one new SpeechProvider +
// one case here + one preset descriptor in providers/presets.ts.

import type { TTSProviderConfig } from './openaiConfigStore';
import { getPreset } from './presets';
import { OpenAISpeechProvider } from './openai';
import { SarvamSpeechProvider } from './sarvam';
import type { SpeechProvider } from './types';

export const createSpeechProvider = (config: TTSProviderConfig): SpeechProvider => {
  const preset = getPreset(config.preset);
  switch (preset.engine) {
    case 'sarvam':
      return new SarvamSpeechProvider(config);
    case 'openai':
    default:
      return new OpenAISpeechProvider(config);
  }
};
