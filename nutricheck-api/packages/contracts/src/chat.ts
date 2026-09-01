import { z } from 'zod';

/**
 * The assistant behind the microphone sheet.
 *
 * Every other AI route in this system answers one shaped question — parse this,
 * rank these, read this meal. This one is open: somebody types a sentence and
 * it is either a meal to log or a question about their day, and until the model
 * has read it nobody knows which.
 *
 * That is the whole design problem, and the reply shape is the answer to it. A
 * turn comes back with something to SAY and, optionally, a phrase to LOG. The
 * app never guesses which it got: `log` present means the sentence was a meal,
 * and the phrase travels on to the same read-back screen a spoken meal goes
 * through. Nothing is written by talking.
 */

/** One turn. `at` is for ordering, never for arithmetic. */
export const ChatTurn = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string().min(1).max(2000),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

/**
 * What the client sends.
 *
 * The history rides along rather than living on the server, and the cap is the
 * reason: a conversation about one day does not need to be durable, and a table
 * of everything anybody has ever said to this app is a retention decision
 * nobody has taken. Twelve turns is roughly the last five exchanges, which is
 * as far back as "what about the other one" ever refers.
 */
export const ChatRequest = z.object({
  message: z.string().trim().min(1).max(500),
  history: z.array(ChatTurn).max(12).default([]),
  /** The day being discussed, so "today" means the user's today and not the server's. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().min(1).max(64),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatReply = z.object({
  /** What to show. One or two sentences; this is a sheet, not a document. */
  text: z.string().max(600),
  /**
   * Set when the message was food rather than a question.
   *
   * The phrase is the user's own words, tidied at most — never the model's
   * summary of them. It is about to be parsed into a meal by a second call, and
   * a paraphrase would put a model's reading of a sentence into a place the
   * user believes holds their sentence.
   */
  log: z
    .object({
      phrase: z.string().min(1).max(500),
    })
    .nullable(),
});
export type ChatReply = z.infer<typeof ChatReply>;
