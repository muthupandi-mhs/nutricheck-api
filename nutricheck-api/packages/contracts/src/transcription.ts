import { z } from 'zod';

/**
 * Server-side transcription — the fallback USER-FLOWS §5 promises "where
 * platform dictation is weak for the user's language".
 *
 * This is the ONLY route in the API that accepts audio, and it is deliberately
 * separate from `/v1/resolve`, which still returns 415 for it. Two reasons.
 * The pipeline stays identical whether words were typed, dictated on-device or
 * transcribed here — there is one parse path, not three. And the expensive,
 * privacy-sensitive step stays visible as its own call rather than hiding
 * inside the route every log already goes through.
 *
 * The device sends audio only when its own recogniser cannot cope. On-device
 * dictation remains the default: free, private, and works with no network.
 */

/** What the recogniser is listening for. Mirrors the app's SpeechLocaleId. */
export const TranscribeLocale = z.enum(['en-IN', 'ta-IN']);
export type TranscribeLocale = z.infer<typeof TranscribeLocale>;

/**
 * Gemini's documented inline types. WAV and AAC are what Android records
 * natively; the rest are accepted because rejecting a format the model handles
 * would be a limitation we invented.
 */
export const AudioMimeType = z.enum([
  'audio/wav',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
]);
export type AudioMimeType = z.infer<typeof AudioMimeType>;

/**
 * Audio arrives base64 in JSON rather than as multipart.
 *
 * A dictated meal is seconds long, so the ~33% base64 overhead is a few
 * hundred kilobytes — cheaper than adding a multipart parser to a stack that
 * otherwise speaks only JSON, and it keeps the route inside the same Zod DTO
 * and RFC 9457 error handling as everything else.
 */
export const TranscribeRequest = z.object({
  /** Base64, no data: URI prefix. */
  audio: z.string().min(1),
  mimeType: AudioMimeType,
  /**
   * Telling the model which language to expect measurably improves a
   * code-switched result — "rendu dosai" is Tamil counting English-adjacent
   * words, and a model guessing the language mangles exactly those.
   */
  locale: TranscribeLocale.default('en-IN'),
});
export type TranscribeRequest = z.infer<typeof TranscribeRequest>;

/**
 * Just the words.
 *
 * Deliberately NOT a draft: transcription produces text, and that text goes
 * into the same box the user can edit before it is ever sent to `/v1/resolve`.
 * Returning a draft here would collapse two steps the user is entitled to see
 * separately — "is this what I said" and "is this what I ate".
 */
export const TranscribeResult = z.object({
  text: z.string(),
  locale: TranscribeLocale,
  model: z.string(),
  latencyMs: z.number().int().nonnegative(),
});
export type TranscribeResult = z.infer<typeof TranscribeResult>;
