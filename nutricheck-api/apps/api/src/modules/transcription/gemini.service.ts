import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TranscribeLocale, TranscribeResult } from '@nutricheck/contracts';
import type { AppConfig } from '../../config/config.schema';
import {
  TranscriptionEmptyError,
  TranscriptionService,
  TranscriptionUnavailableError,
} from './transcription.service';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** A dictated meal is seconds long; anything slower than this is a failure to the user. */
const TIMEOUT_MS = 20_000;

const LANGUAGE: Record<TranscribeLocale, string> = {
  'en-IN': 'Indian English, possibly mixed with Tamil words',
  'ta-IN': 'Tamil, possibly mixed with English words',
};

/**
 * Transcription via Gemini.
 *
 * The instruction is as important as the model here. Left to itself a
 * multimodal model will happily answer the audio — summarise it, translate it,
 * or reply to it — and any of those silently destroys a log. What is wanted is
 * a stenographer.
 *
 * Code-switching is the whole reason this exists. Android's offline models
 * transcribe "rendu dosai" into whatever English they have; the point of
 * spending a network round trip is to keep the user's own words, in whichever
 * script they said them, because the corpus holds both spellings and the parse
 * prompt already reads Tamil numerals.
 */
@Injectable()
export class GeminiTranscriptionService extends TranscriptionService {
  private readonly log = new Logger(GeminiTranscriptionService.name);
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    super();
    this.apiKey = this.config.get('GEMINI_API_KEY', { infer: true });
    this.model = this.config.get('GEMINI_MODEL', { infer: true });
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async transcribe(input: {
    audio: Buffer;
    mimeType: string;
    locale: TranscribeLocale;
  }): Promise<TranscribeResult> {
    if (!this.apiKey) throw new TranscriptionUnavailableError('no API key configured');

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            { type: 'text', text: instruction(input.locale) },
            {
              type: 'audio',
              mime_type: input.mimeType,
              data: input.audio.toString('base64'),
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // A timeout or a dead socket. The caller degrades to on-device rather
      // than showing the user a failure they cannot act on.
      throw new TranscriptionUnavailableError(
        error instanceof Error ? error.message : 'request failed',
      );
    } finally {
      clearTimeout(timer);
    }

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      // The key and the audio never go near a log line. The status and the
      // provider's own message are what anyone debugging actually needs.
      this.log.warn({ status: response.status, detail: providerMessage(body) }, 'transcription refused');
      throw new TranscriptionUnavailableError(`provider returned ${response.status}`);
    }

    const text = extractText(body);
    if (!text) throw new TranscriptionEmptyError('no text in the response');

    return {
      text,
      locale: input.locale,
      model: this.model,
      latencyMs: Date.now() - startedAt,
    };
  }
}

function instruction(locale: TranscribeLocale): string {
  return [
    'Transcribe this audio verbatim. It is somebody saying what they ate.',
    `Expect ${LANGUAGE[locale]}.`,
    '',
    'Rules:',
    '- Output ONLY the words spoken. No preamble, no quotation marks, no commentary.',
    '- Do not translate. Keep every word in the language and script it was said in.',
    '- Keep code-switching intact: "rendu dosai" stays "rendu dosai".',
    '- Write numbers as the speaker said them, in words or digits, whichever they used.',
    '- If the audio contains no speech, output nothing at all.',
  ].join('\n');
}

/**
 * Pull the transcript out of the response.
 *
 * The live Interactions API returns neither `output_text` nor `candidates` —
 * it returns a `steps` array, and the text sits in the step whose type is
 * `model_output`:
 *
 *   { steps: [ { type: 'thought', signature: '...' },
 *              { type: 'model_output', content: [ { type: 'text', text: '...' } ] } ] }
 *
 * Filtering to `model_output` is a correctness requirement, not tidiness. A
 * reasoning model also emits `thought` steps, and sweeping those up would write
 * the model's private deliberation into the user's food log as if they had said
 * it out loud.
 *
 * The older shapes are kept as fallbacks. They cost one branch each and mean a
 * revision on the provider's side is a degraded call rather than a dead
 * feature — this was verified against the live API, and the shape had already
 * moved once before this was written.
 */
function extractText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // Interactions API — the shape actually served today.
  if (Array.isArray(b.steps)) {
    const pieces: string[] = [];
    for (const step of b.steps) {
      if (!step || typeof step !== 'object') continue;
      const s = step as Record<string, unknown>;
      if (s.type !== 'model_output') continue;
      const text = collectText(s.content);
      if (text) pieces.push(text);
    }
    const joined = pieces.join(' ').trim();
    if (joined) return joined;
  }

  // Interactions API, flattened convenience field (SDKs expose this).
  for (const key of ['output_text', 'outputText'] as const) {
    const value = b[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  const fromOutput = collectText(b.output ?? b.content);
  if (fromOutput) return fromOutput;

  // generateContent, the shape that preceded all of the above.
  if (Array.isArray(b.candidates)) {
    for (const candidate of b.candidates) {
      const content = (candidate as Record<string, unknown> | null)?.content;
      const fromParts = collectText(
        (content as Record<string, unknown> | undefined)?.parts ?? content,
      );
      if (fromParts) return fromParts;
    }
  }

  return null;
}

/** Joins every `text` field found one level into an array of parts. */
function collectText(node: unknown): string | null {
  if (typeof node === 'string') return node.trim() || null;
  if (!Array.isArray(node)) return null;

  const pieces: string[] = [];
  for (const entry of node) {
    if (typeof entry === 'string') pieces.push(entry);
    else if (entry && typeof entry === 'object') {
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === 'string') pieces.push(text);
    }
  }

  const joined = pieces.join(' ').trim();
  return joined || null;
}

/** The provider's error message, for the log only — never for the user. */
function providerMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return 'no detail';
  const error = (body as Record<string, unknown>).error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return 'no detail';
}
