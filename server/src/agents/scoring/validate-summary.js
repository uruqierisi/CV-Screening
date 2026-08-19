/**
 * Keeps numbers out of the model's prose.
 *
 * `summary` is the one free-text field the model writes that a recruiter reads
 * as a whole (it becomes `candidates.ai_justification`). Composing it in code
 * from the per-criterion `reason` strings satisfies the shape and loses the
 * substance, so the model writes it - which means the model can write *"roughly
 * an 80% match"* while `computeWeightedScore` returned 73.4, leaving two
 * contradicting figures in front of a recruiter with no way to tell which is
 * real. Plan section 5.1, stated once: **prose from the model, numbers only from
 * code, enforced at the boundary.**
 *
 * This is that boundary. It lives next to `reconcile-ratings.js` because it is
 * the same species of thing - post-parse validation of an evaluation response by
 * a pure function - and not in the schema as a `.refine()`, for the same reason
 * the completeness refine is banned: a refine failure yields
 * `parsed_output === null` with no diagnostic, where a post-parse check can name
 * the pattern that matched.
 *
 * The rule is deliberately narrow, and the narrowness is the design:
 *
 * - It rejects a **figure on the score itself** - a percentage, an `x/10` or
 *   `x/100`, or a number attached to a scoring word.
 * - It does **not** reject **counts**. *"matches 4 of the 6 criteria"*, *"8 years
 *   of experience"*, *"led a team of 12"* and *"since 2019"* are correct
 *   sentences, and rejecting one burns a retry, and real API spend, on a summary
 *   that was right. A false rejection costs more than a rare miss, so where a
 *   pattern could not discriminate it was narrowed until it could.
 *
 * Nothing here is repaired. A rejected summary throws, because silently
 * stripping the number would hide a model that is drifting.
 *
 * ---
 *
 * ## Residual misses, accepted and closed
 *
 * No regex will cover every phrasing of a natural language, and it is not this
 * check's job to try. The **prompt-level prohibition in phase 2b is the primary
 * control**; this module is the backstop for the literal forms a drifting model
 * actually produces. These are known to slip through and are accepted:
 *
 * - **Oblique paraphrase** - *"about four-fifths of what we're looking for"*
 *   states a figure and matches nothing here.
 * - **Spelled-out numbers** - *"rated them eight"*. Every pattern keys on digits.
 * - **Verbs and nouns outside {@link SCORE_WORDS}** - *"gave them a 9"*,
 *   *"assessment: 85"*. Widening that list is a different mechanism from the
 *   tail test and would muddy what these tests document, so it was left alone.
 * - **A score more than {@link MAX_WORDS_BETWEEN_SCORE_WORD_AND_NUMBER} words
 *   from its verb** - *"I rated this very senior candidate 8."*
 *
 * And one accepted false positive in the other direction: *"rated among the top
 * 3 in the region"* is a rank followed by a preposition, so the tail reads it as
 * a score. That costs one retry, and it is the price of not maintaining a list
 * of counted nouns - see {@link CLOSED_CLASS_FUNCTION_WORDS}.
 *
 * Do not add further rounds of hardening here. The next one belongs in the 2b
 * prompt.
 *
 * ---
 *
 * ## Why the scoring-word check has two forms, and why the second one inverts
 *
 * The first version of `quantified_score_word` allowed at most two words from a
 * closed *filler* list ("of", "at", "the", "roughly", ...) between the scoring
 * word and the number. That caught *"rated 8"* and missed *"rated them 8"* -
 * which is how a model most naturally writes it. Anything with an object in the
 * middle (*"I rated this candidate 8"*, *"I would score them 90"*) walked past a
 * check whose tests read as though they covered it.
 *
 * The obvious repair - add `them|candidate|applicant|profile` to the filler
 * list - is the wrong shape, and so is its mirror image: a closed list of unit
 * nouns (`years|months|criteria|roles`) used to *excuse* a number. Both lists
 * are drawn from an **open class**. The next model writes `projects`,
 * `positions`, `certifications`, `languages`, `teams`, and the list is out of
 * date the day it is written. A check maintained against an open class rots.
 *
 * So the second form **inverts the test**. It allows an open, bounded gap
 * between the scoring word and the number, and then looks at what comes
 * **after** the number:
 *
 * - **End of string, punctuation, or scale language** (*"rated them 8."*,
 *   *"scored them 85"*, *"rated them 8 out of 10"*) - the number is a bare
 *   nominal with nothing to count. It is a **score**. Reject.
 * - **A closed-class function word** - a preposition, determiner, conjunction,
 *   pronoun or auxiliary (*"Scoring them 7 **for** this position."*) - the
 *   number ends its phrase and a new one begins, so again nothing is being
 *   counted. It is a **score**. Reject.
 * - **Anything else** - an open-class word, in practice the noun the number
 *   quantifies (*"8 **years**"*, *"4 **criteria**"*, *"3 **applicants**"*,
 *   *"5 **roles**"*, *"12 **services**"*) - the number is a **count**. Pass.
 *
 * That is the whole point of the inversion: **function words are a closed class
 * and nouns are an open one.** Prepositions, determiners, conjunctions and
 * pronouns are a finite, stable inventory that has barely moved in centuries; a
 * list of them is finished the day it is written. Nouns are coined weekly. By
 * enumerating the closed class and letting *every* unenumerated word mean
 * "count", the check ages instead of rotting: a phrasing this file has never
 * seen, using a noun this file has never heard of, still classifies correctly.
 *
 * One deliberate hole in that list: **`of` is not a rejecting function word**,
 * because *"scored highly across 4 of the 6 criteria"* is the partitive count
 * construction and must pass. `of` *before* the number (*"a score of 80"*) is a
 * different sentence and is handled by the first form.
 *
 * Residual cost, stated plainly: *"rated among the top 3 in the region"* is a
 * rank followed by a preposition, and is rejected. That is a false rejection -
 * one retry - and it is the price of not maintaining a noun list. The failure
 * this check exists to stop puts a second, invented figure next to the computed
 * score in front of a recruiter, which is the more expensive outcome.
 */

import { SummaryContainsScoreError } from '../errors.js';

/**
 * The longest span reported back in an error. The reported span is either drawn
 * from a closed alphabet (digits, punctuation, and words from the lists in this
 * file) or elided - see {@link redactGap} - so a match cannot carry a
 * candidate's name into a log line. The bound costs nothing and makes that
 * property hold regardless of how the patterns are edited later.
 */
const MAX_REPORTED_MATCH_LENGTH = 40;

/**
 * How many words may sit between the scoring word and the number in the loose
 * form. Three, because the longest natural object of a scoring verb is
 * determiner + modifier + head noun - *"rated this senior candidate 8"* - and
 * past that the two are almost always in different clauses. The cap is
 * load-bearing: without it, *"Their rating is strong, and they have shipped 12
 * services"* puts a scoring word and an unrelated number in one sentence and the
 * tail test would be the only thing standing between them.
 *
 * The gap alphabet reinforces the cap. A gap word is letters only, so a comma, a
 * full stop, a digit or a slash ends the window immediately - a match cannot
 * cross a clause boundary however generous the cap is set.
 */
const MAX_WORDS_BETWEEN_SCORE_WORD_AND_NUMBER = 3;

/**
 * Words that mean "this number is a score". `match` and `matches` are pointedly
 * absent: *"matches 4 of the 6 criteria"* is a count and must pass, while
 * *"80% match"* is already caught as a percentage. Leaving `match` out of this
 * list is what makes those two cases separable at all.
 */
const SCORE_WORDS = 'scores?|scored|scoring|rates?|rated|ratings?';

/**
 * The closed list of tokens that bind a number *directly* to a scoring word:
 * *"a score **of** 80"*, *"rated **at** 8.5"*, *"rating**:** 8"*.
 *
 * The reason this form rejects without consulting the tail is linguistic rather
 * than mechanical: the preposition binds the number to the score word and rules
 * out a count reading, while a bare *"scored 8"* is an ordinary count.
 *
 * So a binding token - or a colon - must actually be **present**. *"A score of
 * 80 seems right."* is rejected here precisely because this form ignores what
 * follows: `seems` is an open-class word and the tail test would wave it
 * through. A zero-binding *"scored 8 projects"* is not this form's business; it
 * falls through to form two, where the tail decides and `projects` reads it as
 * the count it is.
 */
const SCORE_BINDING_TOKENS = 'of|at|is|was|as|a|an|the|around|about|roughly|approximately';

/** A single gap word: letters, with internal apostrophes and hyphens allowed. */
const GAP_WORD = '[A-Za-z][A-Za-z’\'-]*';

/**
 * Language that puts a number on a scale rather than on a set of things. It
 * follows the number, so it is read as part of the tail test below. `out of` is
 * here rather than in the function-word list because bare `of` must not reject -
 * *"4 of the 6 criteria"* is a count.
 */
const SCALE_LANGUAGE = 'out\\s+of|overall|or|versus|vs|against|compared|points?|marks?';

/**
 * The closed-class function words: prepositions, determiners, conjunctions,
 * pronouns and auxiliaries. A finite inventory the language is not adding to,
 * which is exactly why the check is maintained against this list and not against
 * a list of nouns. A number followed by one of these has ended its noun phrase
 * without a head noun, which means it was not counting anything.
 *
 * `of` is deliberately absent - see the module docstring.
 */
const CLOSED_CLASS_FUNCTION_WORDS = [
  // determiners and quantifiers
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'some',
  'any', 'no', 'both', 'either', 'neither', 'my', 'your', 'his', 'her', 'its',
  'our', 'their',
  // pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'them', 'us',
  'who', 'whom', 'whose', 'which', 'what',
  // prepositions - never `of`
  'in', 'on', 'at', 'to', 'for', 'with', 'without', 'within', 'by', 'from',
  'into', 'onto', 'over', 'under', 'above', 'below', 'before', 'after',
  'during', 'since', 'until', 'till', 'through', 'across', 'among', 'amongst',
  'between', 'behind', 'beyond', 'beside', 'besides', 'near', 'per', 'toward',
  'towards', 'upon', 'about', 'around', 'despite', 'unlike',
  // conjunctions and subordinators
  'and', 'but', 'nor', 'yet', 'so', 'because', 'although', 'though', 'while',
  'whereas', 'if', 'unless', 'whether', 'than', 'as',
  // auxiliaries and copulas
  'is', 'was', 'are', 'were', 'be', 'been', 'being', 'am', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'shall', 'do', 'does',
  'did', 'has', 'have', 'had',
  // pro-forms and negation
  'not', 'too', 'then', 'there', 'here',
].join('|');

/** A number, with an optional decimal part. Shared by every pattern below. */
const NUMBER = '\\d+(?:\\.\\d+)?';

/**
 * A percentage, in symbol or spelled form. The decimal group requires a digit
 * after the dot so a sentence boundary - "...in 2019. Percentages aside..." -
 * cannot be read as "2019 percent".
 */
const PERCENTAGE = new RegExp(`\\b${NUMBER}\\s*(?:%|percent\\b|per\\s+cent\\b)`, 'i');

/**
 * An x/10 or x/100 rating - the two scales a score is expressed on. `4/6` is a
 * count and is left alone. The trailing lookahead keeps a date out of it: in
 * `10/10/2023` the `/` after the second `10` refuses the match.
 */
const OUT_OF_TEN_OR_HUNDRED = new RegExp(`\\b${NUMBER}\\s*\\/\\s*(?:10|100)\\b(?![\\d/])`);

/**
 * Form one: the number is bound to the scoring word by a colon or by at least
 * one binding token. Rejected unconditionally - see {@link SCORE_BINDING_TOKENS}
 * for why the binder must be present rather than optional.
 */
const DIRECTLY_BOUND_SCORE = new RegExp(
  `\\b(?:${SCORE_WORDS})\\b` +
    `(?::(?:\\s+(?:${SCORE_BINDING_TOKENS})\\b){0,2}` +
    `|(?:\\s+(?:${SCORE_BINDING_TOKENS})\\b){1,2})` +
    `\\s+${NUMBER}`,
  'i',
);

/**
 * Form two: a scoring word, **zero** to three arbitrary words, then a number.
 * This matches *"rated them 8"* (a score), *"rating reflects 8 years"* (a
 * count) and the zero-gap *"scored 8 projects"* (also a count), so a match here
 * decides nothing on its own - {@link SCORE_LIKE_TAIL} decides.
 *
 * The gap starts at zero because form one now requires a binder, which leaves
 * bare *"scored 8"* to be judged on what follows it. Group 1 is the scoring word
 * and group 2 the number; any gap between them is arbitrary model prose and is
 * never reported.
 */
const LOOSELY_BOUND_SCORE = new RegExp(
  `\\b(${SCORE_WORDS})\\b(?:\\s+${GAP_WORD}){0,${MAX_WORDS_BETWEEN_SCORE_WORD_AND_NUMBER}}\\s+(${NUMBER})`,
  'i',
);

/**
 * What follows a loosely-bound number when that number is a score: nothing at
 * all, punctuation, scale language, or a closed-class function word. Anything
 * else - an open-class word, in practice the noun being counted - is a count and
 * passes.
 */
const SCORE_LIKE_TAIL = new RegExp(
  `^(?:\\s*$|\\s*[^\\w\\s]|\\s+(?:${SCALE_LANGUAGE}|${CLOSED_CLASS_FUNCTION_WORDS})\\b)`,
  'i',
);

/**
 * Every regex in this module, exported so the suite can assert the properties
 * that must hold of all of them - notably that none carries the `g` flag, which
 * would make matching stateful across calls.
 *
 * @type {readonly RegExp[]}
 */
export const SCORE_FIGURE_REGEXES = Object.freeze([
  PERCENTAGE,
  OUT_OF_TEN_OR_HUNDRED,
  DIRECTLY_BOUND_SCORE,
  LOOSELY_BOUND_SCORE,
  SCORE_LIKE_TAIL,
]);

/**
 * @param {RegExp} pattern non-global, so it carries no `lastIndex` state
 * @param {string} summary
 * @returns {string | null} the matched span, or `null`
 */
function firstMatch(pattern, summary) {
  const found = pattern.exec(summary);
  return found === null ? null : found[0];
}

/**
 * The span reported for a loose match. The gap is model prose and could contain
 * a candidate's name - *"we rated Priya 8"* - and `details` goes to the logs, so
 * the gap is elided and only the scoring word and the number are reported.
 *
 * @param {string} scoreWord
 * @param {string} number
 * @returns {string}
 */
function redactGap(matched, scoreWord, number) {
  // Nothing between the two words is nothing to redact: report "Scores 85"
  // verbatim rather than the noisier "Scores ... 85".
  const between = matched.slice(scoreWord.length, matched.length - number.length);
  return between.trim() === '' ? matched : `${scoreWord} ... ${number}`;
}

/**
 * Finds a number attached to a scoring word that is a score rather than a count.
 *
 * @param {string} summary
 * @returns {string | null} the offending span, or `null` when every number near
 *   a scoring word is counting something
 */
function findQuantifiedScoreWord(summary) {
  const directlyBound = firstMatch(DIRECTLY_BOUND_SCORE, summary);
  if (directlyBound !== null) {
    return directlyBound;
  }

  // A fresh global regex per call rather than a shared one: `matchAll` needs the
  // `g` flag, and a module-level global regex is a `lastIndex` bug waiting to
  // happen. Scanning every candidate matters, because a summary can legitimately
  // count before it scores - "their rating reflects 8 years... I would score
  // them 90" must be rejected on the second occurrence, not passed on the first.
  const scan = new RegExp(LOOSELY_BOUND_SCORE.source, 'gi');
  for (const found of summary.matchAll(scan)) {
    const tail = summary.slice(found.index + found[0].length);
    if (SCORE_LIKE_TAIL.test(tail)) {
      return redactGap(found[0], found[1], found[2]);
    }
  }

  return null;
}

/**
 * @typedef {object} ScoreFigurePattern
 * @property {string} id stable identifier, safe to log and to assert on
 * @property {string} description what a reader needs to know to fix it
 * @property {(summary: string) => string | null} find the offending span, or `null`
 */

/**
 * Every form of "a figure on the score" this layer rejects, in the order they
 * are tried. Exported so the suite can assert the list itself, rather than only
 * the behaviour of whichever entries somebody remembered to test.
 *
 * @type {readonly ScoreFigurePattern[]}
 */
export const SCORE_FIGURE_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'percentage',
    description: 'a percentage, in symbol or spelled form',
    find: (summary) => firstMatch(PERCENTAGE, summary),
  }),
  Object.freeze({
    id: 'out_of_ten_or_hundred',
    description: 'an x/10 or x/100 rating',
    find: (summary) => firstMatch(OUT_OF_TEN_OR_HUNDRED, summary),
  }),
  Object.freeze({
    id: 'quantified_score_word',
    description: 'a number attached to a scoring word, e.g. "score of 80", "rated them 8"',
    find: findQuantifiedScoreWord,
  }),
]);

/**
 * @typedef {object} ScoreFigure
 * @property {string} patternId which entry of {@link SCORE_FIGURE_PATTERNS} matched
 * @property {string} description that entry's human-readable description
 * @property {string} match the offending span, truncated, for the error message
 */

/**
 * Finds the first score-shaped figure in a summary. Pure: text in, a plain
 * object or `null` out. No throw, so callers that want to inspect rather than
 * fail can.
 *
 * @param {string | null} summary the model's summary, exactly as parsed. `null`
 *   is legal - the schema allows it, and "nothing to add" is a valid answer.
 * @returns {ScoreFigure | null} `null` when the summary is prose only
 */
export function findScoreFigure(summary) {
  if (typeof summary !== 'string') {
    // Covers `null` from the schema and anything a non-model caller hands in.
    // Absence of prose cannot contain a number.
    return null;
  }

  for (const { id, description, find } of SCORE_FIGURE_PATTERNS) {
    const match = find(summary);
    if (match !== null) {
      return {
        patternId: id,
        description,
        match: match.slice(0, MAX_REPORTED_MATCH_LENGTH),
      };
    }
  }

  return null;
}

/**
 * Throws unless the summary is prose only.
 *
 * Called after `messages.parse` succeeds and before the evaluation is handed to
 * anything downstream (phase 2b wires it in). The throw is retryable: unlike the
 * reconciliation failures, which re-fail identically forever, a fresh generation
 * is very likely to be clean - so this takes the normal semantic retry path of
 * plan section 5.4 rather than failing the candidate.
 *
 * @param {string | null} summary
 * @returns {void}
 * @throws {SummaryContainsScoreError} if a score-shaped figure is present
 */
export function assertSummaryIsProseOnly(summary) {
  const found = findScoreFigure(summary);
  if (found !== null) {
    throw new SummaryContainsScoreError(found);
  }
}
