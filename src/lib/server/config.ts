export const config = {
  openaiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
  openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  openaiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1",
};
