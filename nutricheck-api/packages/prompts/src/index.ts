import { createHash } from 'node:crypto';
import { IDENTIFY_SYSTEM } from './identify';
import { INSIGHT_SYSTEM } from './insight';
import { MEAL_SYSTEM } from './meal';
import { PARSE_SYSTEM } from './parse';
import { RERANK_SYSTEM } from './rerank';
import { TARGETS_SYSTEM } from './targets';

export { IDENTIFY_SYSTEM, INSIGHT_SYSTEM, MEAL_SYSTEM, PARSE_SYSTEM, RERANK_SYSTEM, TARGETS_SYSTEM };

/**
 * Prompt version, derived from the prompt's own bytes.
 *
 * Deriving it rather than hand-maintaining a number means it cannot drift: a
 * prompt edit IS a version change, with no way to forget to bump it. That
 * matters in two places — `ai_runs.prompt_version`, where it makes a quality
 * regression name its own cause, and the phrase-cache key, where a stale entry
 * from the previous prompt would otherwise be served indefinitely.
 */
function versionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export const PROMPTS = {
  parse: {
    system: PARSE_SYSTEM,
    version: versionOf(PARSE_SYSTEM),
  },
  rerank: {
    system: RERANK_SYSTEM,
    version: versionOf(RERANK_SYSTEM),
  },
  insight: {
    system: INSIGHT_SYSTEM,
    version: versionOf(INSIGHT_SYSTEM),
  },
  identify: {
    system: IDENTIFY_SYSTEM,
    version: versionOf(IDENTIFY_SYSTEM),
  },
  meal: {
    system: MEAL_SYSTEM,
    version: versionOf(MEAL_SYSTEM),
  },
  targets: {
    system: TARGETS_SYSTEM,
    version: versionOf(TARGETS_SYSTEM),
  },
} as const;

/**
 * Combined version, for anything keyed on "the prompts as a whole" — the phrase
 * cache and the eval report both want a single value that changes when either
 * half does.
 */
export const PROMPT_VERSION = versionOf(
  `${PROMPTS.parse.version}:${PROMPTS.rerank.version}`,
);

/**
 * Rough token count, used only to assert the cached prefix clears Claude Opus
 * 5's 512-token minimum. Below that a prompt silently does not cache: no error,
 * no warning, just `cache_creation_input_tokens: 0` and a tripled bill.
 *
 * ~4 characters per token is close enough for a floor check. The real number
 * comes from countTokens() against the live API.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Claude Opus 5. It was 1024 on Opus 4.8 — do not assume it is the same. */
export const MIN_CACHEABLE_TOKENS = 512;
