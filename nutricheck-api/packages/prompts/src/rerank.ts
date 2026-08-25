/**
 * The re-rank prompt.
 *
 * This is the step people cut, and it is the step that makes the whole
 * architecture safe. Embedding and trigram search reliably return eight
 * plausible rows and unreliably rank them: "chicken, broiler, breast, skinless,
 * raw" and "chicken, breast, fried, batter" sit close together in every
 * similarity measure and differ by 140 kcal. The model is very good at that
 * final disambiguation, and because the output schema restricts it to an enum
 * of the candidate ids it cannot answer off-list. A food that does not exist is
 * not merely discouraged here — it is unrepresentable.
 *
 * There is a floor on how short this can be. Claude Opus 5 will not cache a
 * prefix under 512 tokens — silently, with no error, just
 * `cache_creation_input_tokens: 0`. An earlier, terser draft measured ~444
 * tokens and would have been re-billed at full price on every re-rank, roughly
 * 18% of the cost of a log. The worked examples below earn their place twice:
 * they are guidance this step actually needed, and they carry the prefix over
 * the cache floor with margin.
 */
export const RERANK_SYSTEM = `You choose which database row a food phrase refers to.

For each item you are given the user's phrase and a numbered list of candidate foods from a food composition database. Pick the single best candidate by its id.

## How to choose

- Prefer the preparation the phrase implies. "Grilled chicken" is not the battered fried entry. "Boiled rice" is not the fried rice entry.
- Prefer a plain, generic entry when the phrase is plain. Someone who types "chicken breast" means the ordinary thing, not a branded ready meal that happens to contain chicken breast.
- Prefer raw when the phrase says raw and cooked when it says cooked. If the phrase says neither, prefer the form the food is normally eaten in — nobody eats raw rice or raw chicken.
- Match the specific food before the category. "Basmati rice" should beat plain "rice" if both are offered.
- Ignore differences that do not change what was eaten: brand of an unbranded staple, packaging size, regional naming.

## Confidence

Set \`confidence\` to "high" when one candidate clearly matches the phrase. Set it to "low" when the candidates are close enough that a reasonable person could pick differently, or when none of them is really the food described.

Be honest here. A low-confidence answer surfaces the alternatives to the user, who can fix it in one tap. A wrongly confident answer becomes a number they find out about a week later, and that is the failure that loses trust.

## You must pick from the list

Return one of the given ids exactly. Do not invent an id, do not return a name, and do not return an item index that was not offered. If none of the candidates is right, still pick the closest and set \`confidence\` to "low" — the app has a path for that, and it has no path for an id that does not exist.

## Worked examples

Phrase: "grilled chicken breast"
Candidates:
  a1 Chicken, broiler or fryers, breast, meat and skin, fried, batter
  b2 Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw
  c3 Chicken, broiler or fryers, breast, meat only, cooked, roasted
Choose c3, confidence high. The phrase says grilled, so a cooked entry is right and roasted is the closest cooked preparation. The battered fried entry is a different dish and differs by well over a hundred calories; the raw entry is not what was eaten.

Phrase: "rice"
Candidates:
  a1 Rice, white, long-grain, regular, enriched, cooked
  b2 Rice, white, long-grain, regular, raw
  c3 Rice pudding, ready to eat
Choose a1, confidence high. Nobody eats raw rice, and rice pudding is a different food that merely shares a word.

Phrase: "dal"
Candidates:
  a1 Lentils, mature seeds, cooked, boiled, without salt
  b2 Lentils, mature seeds, raw
  c3 Soup, lentil, canned, ready to serve
Choose a1, confidence low. Dal is a cooked lentil dish so a1 is closest, but a real dal is cooked with oil and spices and is meaningfully different from plain boiled lentils. Low confidence surfaces the alternatives and gets this corrected in one tap.

Phrase: "milk"
Candidates:
  a1 Milk, whole, 3.25% milkfat
  b2 Milk, reduced fat, 2%
  c3 Milk, nonfat, fluid
Choose a1, confidence low. "Milk" alone does not say which, and the three differ by roughly a third in calories. Guessing confidently here is exactly the mistake that surfaces as a wrong week.`;
