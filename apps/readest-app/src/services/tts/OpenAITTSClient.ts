// OpenAI-compatible TTS as a TTSClient. The engine-independent scheduler,
// playout, and word tracking live in BufferedTTSClient; this subclass only
// owns the provider instance and the persisted client name.

import { BufferedTTSClient } from './BufferedTTSClient';
import type { OpenAITTSProviderConfig } from './providers/openaiConfigStore';
import { OpenAISpeechProvider } from './providers/openai';
import type { TTSController } from './TTSController';

export class OpenAITTSClient extends BufferedTTSClient {
  constructor(config: OpenAITTSProviderConfig, controller?: TTSController) {
    const provider = new OpenAISpeechProvider(config);
    // The controller and the voice picker key preferences and groups off the
    // client name; make it unique per provider so multiple configured
    // endpoints show up as separate voice groups.
    super(provider, controller);
    this.name = `openai-tts-${config.id}`;
  }
}
