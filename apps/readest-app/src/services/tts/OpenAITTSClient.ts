// A buffered TTS client for a user-configured custom provider. The provider
// may run any preset engine (OpenAI-compatible, Sarvam, ...) — the engine is
// chosen by the config's preset via createSpeechProvider. The engine-
// independent scheduler, playout, and word tracking live in BufferedTTSClient;
// this subclass only owns the provider instance and the persisted client name.

import { BufferedTTSClient } from './BufferedTTSClient';
import type { TTSProviderConfig } from './providers/openaiConfigStore';
import { createSpeechProvider } from './providers/factory';
import type { TTSController } from './TTSController';

export class OpenAITTSClient extends BufferedTTSClient {
  constructor(config: TTSProviderConfig, controller?: TTSController) {
    const provider = createSpeechProvider(config);
    // The controller and the voice picker key preferences and groups off the
    // client name; make it unique per provider so multiple configured
    // endpoints show up as separate voice groups.
    super(provider, controller);
    // NB: TTSUtils persists preferred voice/client keyed by this exact name,
    // so it must stay stable across engine changes. `openai-tts-` is kept as
    // the historical prefix even for non-OpenAI engines to preserve the
    // user's remembered selection.
    this.name = `openai-tts-${config.id}`;
  }
}
