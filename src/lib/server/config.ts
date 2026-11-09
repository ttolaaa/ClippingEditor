export const config = {
  openaiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
  openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  openaiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1",
  geminiKey: process.env.GEMINI_API_KEY?.trim() || "",
  geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
  /** Used when the main model is overloaded or times out (faster, but its timestamps are rougher — the client re-times lines). */
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.5-flash",
  /** Groq (OpenAI-compatible): used when Gemini is not set up or its daily quota is used up. */
  groqKey: process.env.GROQ_API_KEY?.trim() || "",
  groqSpeechModel: process.env.GROQ_SPEECH_MODEL?.trim() || "whisper-large-v3",
  groqTextModel: process.env.GROQ_TEXT_MODEL?.trim() || "qwen/qwen3.8-27b",
};

/** Some cloud AI provider is configured (text features prefer OpenAI, then Gemini, then Groq). */
export const cloudConfigured = () => !!(config.openaiKey || config.geminiKey || config.groqKey);
export const textModelName = () =>
  config.openaiKey ? config.openaiModel : config.geminiKey ? config.geminiModel : config.groqKey ? config.groqTextModel : null;
