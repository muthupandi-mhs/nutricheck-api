import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizeSearchText, type ChatReply, type ChatRequest } from '@nutricheck/contracts';
import { AiRunsService } from '../ai/ai-runs.service';
import { AiService } from '../ai/ai.service';
import { LogsService } from '../logs/logs.service';
import { QuotaService } from '../quota/quota.service';
import { chatContext } from './chat-input';

/**
 * One turn of the assistant.
 *
 * Thin on purpose. It builds the context, spends a quota unit, asks once, and
 * hands back what it got — there is no retry, no fallback answer and no second
 * model to ask when the first declines, because every one of those would be
 * this service deciding what the user is told when the thing that was supposed
 * to decide could not.
 *
 * Two rules it enforces on the way out, and they are the only editorial it
 * does:
 *
 *   - a reply with nothing to say is a failure, not an empty bubble
 *   - a phrase to log must be the user's OWN words. The model is told to echo
 *     them; if what comes back has drifted too far from what went in, the log
 *     is dropped and the reply stands on its own. A paraphrase would put the
 *     model's reading of a sentence into the place the user believes holds
 *     their sentence, and the read-back screen would then be reviewing words
 *     nobody said.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiRuns: AiRunsService,
    private readonly logs: LogsService,
    private readonly quota: QuotaService,
  ) {}

  get isConfigured(): boolean {
    return this.ai.isConfigured;
  }

  async reply(userId: string, request: ChatRequest): Promise<ChatReply> {
    const day = await this.logs.day(userId, request.date, request.tz);

    const turn = chatContext({
      day,
      history: request.history,
      message: request.message,
      date: request.date,
    });

    // QuotaGuard has already refused an exhausted user; this books the unit. A
    // call that then fails is refunded, on the resolver's reasoning: nobody
    // should pay a daily unit for our provider having a bad minute.
    await this.quota.consume(userId);

    let result;
    try {
      result = await this.ai.chat(turn);
    } catch (error) {
      await this.quota.refund(userId).catch(() => undefined);
      throw error;
    }

    await this.aiRuns.recordCall(userId, 'chat', hashOf(request.message), result);

    const log = result.value.log;
    if (log && !echoes(request.message, log.phrase)) {
      // Worth a warning rather than a silent drop: a model that keeps
      // rewriting people's sentences is a prompt problem, and this is the only
      // place it would ever be visible.
      this.logger.warn(
        { said: request.message, returned: log.phrase },
        'chat returned a phrase that is not what the user said; not logging it',
      );
      return { text: result.value.text, log: null };
    }

    return { text: result.value.text, log };
  }
}

/**
 * Is this phrase recognisably the sentence the user typed?
 *
 * Not equality. The model is meant to tidy — drop an 'I had', drop the time
 * word, close up a transcript's spacing — and demanding an exact match would
 * throw away every useful correction it makes.
 *
 * Containment, and in ONE direction only: what comes back must be inside what
 * went in. That asymmetry is the whole guarantee. A tidy removes words, so it
 * is a subset; an invention ADDS them, and 'idli and sambar' coming back as
 * '3 idli and sambar' is a quantity nobody said, on the one screen where a
 * quantity is believed. Allowing the reverse direction — which this did at
 * first — passes exactly that case.
 *
 * Compared with the spacing removed, because a transcript writes
 * 'chickenbriyani' and the model answers 'chicken briyani': one space is not
 * a substitution, and treating it as one would drop every log from a
 * run-together transcript, which is most of them.
 *
 * A tidy that reorders or respells fails this and loses its log. That is the
 * safe direction: the reply still stands, and the worst outcome is somebody
 * having to say it again.
 */
export function echoes(said: string, phrase: string): boolean {
  const compact = (text: string) => normalizeSearchText(text).replace(/[^a-z0-9]/g, '');
  const a = compact(said);
  const b = compact(phrase);
  if (a.length === 0 || b.length === 0) return false;
  return a.includes(b);
}
/** Same shape as every other run key: normalized text, so near-identical asks group. */
function hashOf(message: string): string {
  return createHash('sha256').update(normalizeSearchText(message)).digest('hex');
}
