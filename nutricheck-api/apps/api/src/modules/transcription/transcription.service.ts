import type { TranscribeLocale, TranscribeResult } from '@nutricheck/contracts';

/**
 * What the transcription route is allowed to know about the provider.
 *
 * Mirrors `AiService`: the controller depends on this, never on a concrete
 * client, so the route is testable without a network and swapping provider is
 * one binding rather than an edit to the controller.
 *
 * Kept OFF `AiService` on purpose. That interface is the resolver's contract —
 * parse and re-rank, structured output, prompt caching, cost accounting per
 * `ai_runs`. Transcription shares none of it: different provider, different
 * billing unit, different failure modes, and the resolver must keep working
 * when this is not configured at all.
 */
export abstract class TranscriptionService {
  abstract transcribe(input: {
    audio: Buffer;
    mimeType: string;
    locale: TranscribeLocale;
  }): Promise<TranscribeResult>;

  /** False when no key is configured — the route returns 503 and the app stays on-device. */
  abstract get isConfigured(): boolean;
}

/** The provider is configured but could not be reached, or refused. */
export class TranscriptionUnavailableError extends Error {}

/** The provider answered, but with nothing usable in it. */
export class TranscriptionEmptyError extends Error {}
