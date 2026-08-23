// TTS constants shared across the TTS subsystem. Living outside
// TTSController/BufferedTTSClient keeps the client/provider modules free of a
// hard value-import cycle (TTSController imports the clients, the buffered
// client imports TTSController for this constant).

export const DEFAULT_PARAGRAPH_GAP_SEC = 0.3;
