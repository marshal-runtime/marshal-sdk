/**
 * Marley's speech (zygstinct `packages/speech`, copied as it is): transcription and synthesis, Google (Chirp 3 STT, Gemini TTS) by default and
 * ElevenLabs when its key is set. A separate entry so a host that never speaks does not install `google-auth-library`.
 */
export * from "./marley-packages/speech/index.js";
