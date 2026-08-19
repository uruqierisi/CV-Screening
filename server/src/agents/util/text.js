/**
 * Text normalization shared by evidence verification and rule matching.
 *
 * One module, because "does this quote appear in the CV" and "does this skill
 * match this rule" must fold the same characters the same way. Two private
 * normalizers would drift, and the drift would show up as a candidate eliminated
 * by a rule whose skill the evidence checker considered matched.
 *
 * Phase 2b adds the "is this text worth spending a token on" guard from plan
 * section 5.5 to this file. Nothing here reaches the network or looks at a file.
 */

/**
 * Characters that mean "dash" to a human and are different code points to a
 * machine. CV exports from Word and PDF are full of them, and a verbatim quote
 * that differs from the source only by an en dash is still a verbatim quote.
 */
const DASH_PATTERN = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2043\u2212\uFE58\uFE63\uFF0D]/g;

/** Typographic quotes, same argument as dashes. */
const SINGLE_QUOTE_PATTERN = /[\u2018\u2019\u201A\u201B\u2032]/g;
const DOUBLE_QUOTE_PATTERN = /[\u201C\u201D\u201E\u201F\u2033]/g;

/** Zero-width and byte-order marks: invisible, and lethal to a substring match. */
const INVISIBLE_PATTERN = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/** Any run of whitespace, including the non-breaking space PDFs love. */
const WHITESPACE_RUN_PATTERN = /\s+/g;

/**
 * Token separators. `+` and `#` are deliberately NOT separators: "C++" and "C#"
 * are skill names, and a tokenizer that split them would match "C" against
 * "C++" and eliminate nobody correctly.
 */
const TOKEN_SEPARATOR_PATTERN = /[^\p{L}\p{N}+#]+/gu;

/**
 * Collapses every whitespace run to a single space and trims.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeWhitespace(value) {
  return value.replace(INVISIBLE_PATTERN, '').replace(WHITESPACE_RUN_PATTERN, ' ').trim();
}

/**
 * Folds every difference that should not change the meaning of a string:
 * compatibility normalization, unicode dashes and quotes, case, whitespace.
 *
 * This is the single definition of "the same text" for the whole agent layer.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeForMatch(value) {
  const folded = value
    .normalize('NFKC')
    .replace(DASH_PATTERN, '-')
    .replace(SINGLE_QUOTE_PATTERN, "'")
    .replace(DOUBLE_QUOTE_PATTERN, '"');

  return normalizeWhitespace(folded).toLowerCase();
}

/**
 * Splits normalized text into matchable tokens.
 *
 * @param {string} value
 * @returns {string[]} possibly empty
 */
export function tokenize(value) {
  const tokens = normalizeForMatch(value).split(TOKEN_SEPARATOR_PATTERN);
  return tokens.filter((token) => token.length > 0);
}

/**
 * True when `needle` appears in `haystack` as a contiguous run of whole tokens.
 *
 * Token-boundary matching rather than substring matching, because substring
 * matching says "Java" is present in a CV that only mentions JavaScript - and a
 * required-skill rule that fires on that is worse than no rule at all.
 *
 * An empty needle matches nothing. A requirement that specifies nothing is not
 * satisfied by everything.
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
export function containsTokenSequence(haystack, needle) {
  const needleTokens = tokenize(needle);
  if (needleTokens.length === 0) {
    return false;
  }

  const haystackTokens = tokenize(haystack);
  const limit = haystackTokens.length - needleTokens.length;

  for (let start = 0; start <= limit; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needleTokens.length; offset += 1) {
      if (haystackTokens[start + offset] !== needleTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }

  return false;
}

/**
 * Trimmed, case-sensitive equality. What `matchMode: 'exact'` means: the
 * recruiter typed the string they want and does not want it interpreted.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function equalsExact(left, right) {
  return normalizeWhitespace(left) === normalizeWhitespace(right);
}

/**
 * True when the normalized `needle` occurs as a substring of the normalized
 * `haystack`.
 *
 * Substring rather than token matching here on purpose: this backs evidence
 * verification, where the claim is that a span was copied verbatim out of the
 * source, and the only tolerance we grant is the invisible-difference folding
 * above. An empty quote verifies nothing.
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
export function containsNormalized(haystack, needle) {
  const normalizedNeedle = normalizeForMatch(needle);
  if (normalizedNeedle.length === 0) {
    return false;
  }
  return normalizeForMatch(haystack).includes(normalizedNeedle);
}

/**
 * The cheapest possible failure - plan section 5.5.
 *
 * Ownership is split on purpose. `server/src/extraction/` (phase 3) answers "can
 * I get text out of this file" and raises `EXTRACTION_FAILED` or
 * `EMPTY_DOCUMENT`. This answers a different question - "is what came out worth
 * spending a token on" - and it runs immediately before the first API call, so a
 * scanned PDF whose text layer yielded three words of page furniture costs
 * nothing at all.
 *
 * The redundancy with phase 3 is intentional. Two cheap checks that overlap are
 * better than one check in a file somebody might later reorganise.
 *
 * This function is a judgement, not a throw: it returns what it found and lets
 * `extract-profile.js` decide. Keeping it that way means `util/` still imports
 * nothing, and means a caller that wants to log the statistics without failing
 * the candidate can.
 */

/**
 * The bars a CV has to clear. Set to reject page furniture, not to reject short
 * CVs: a genuinely thin one-page CV is a candidate a recruiter should get to
 * see, and rejecting it here would look identical to a parsing bug.
 */
export const CV_TEXT_THRESHOLDS = Object.freeze({
  /** About two sentences. Below this there is nothing to extract from. */
  MIN_CHARACTERS: 200,
  /**
   * Letters as a fraction of non-whitespace characters. A failed text layer
   * yields punctuation, ligature debris and box-drawing characters; prose does
   * not. Half is lenient enough for a CV that is mostly dates and bullet glyphs.
   */
  MIN_ALPHABETIC_RATIO: 0.5,
});

/**
 * Words that mean "this document is a CV". One is enough. The list is
 * deliberately short and generic - it is a smoke test against a random PDF that
 * happens to be prose, not a classifier, and every entry added to it is another
 * chance to reject a real CV that words things differently.
 */
const CV_SIGNAL_WORDS = Object.freeze([
  'experience',
  'education',
  'skills',
  'employment',
  'qualification',
  'certification',
  'curriculum vitae',
  'resume',
  'work history',
  'career',
  'university',
  'college',
  'degree',
  'project',
  'responsibilities',
]);

/** A four-digit year in a plausible range. Almost every CV carries one. */
const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;

/** Letters in any script, so a non-English CV is not penalised by this check. */
const LETTER_PATTERN = /\p{L}/gu;

/**
 * @typedef {object} CvTextAssessment
 * @property {boolean} usable
 * @property {('too_short' | 'not_enough_letters' | 'no_cv_signal')[]} failures
 * @property {{ characters: number, letters: number, alphabeticRatio: number }} stats
 *   counts only - safe to log, and containing no span of the document
 */

/**
 * Judges whether text is worth an extraction call.
 *
 * @param {unknown} text
 * @returns {CvTextAssessment}
 */
export function assessCvText(text) {
  const value = typeof text === 'string' ? normalizeWhitespace(text) : '';
  const characters = value.length;
  const letters = (value.match(LETTER_PATTERN) ?? []).length;
  const nonWhitespace = value.replace(/\s/g, '').length;
  // A ratio over an empty document is 0, not NaN: the length check has already
  // failed it, and NaN in a log line tells a reader nothing.
  const alphabeticRatio = nonWhitespace === 0 ? 0 : letters / nonWhitespace;

  /** @type {CvTextAssessment['failures']} */
  const failures = [];

  if (characters < CV_TEXT_THRESHOLDS.MIN_CHARACTERS) {
    failures.push('too_short');
  }
  if (alphabeticRatio < CV_TEXT_THRESHOLDS.MIN_ALPHABETIC_RATIO) {
    failures.push('not_enough_letters');
  }

  const lowered = value.toLowerCase();
  const hasSignal =
    YEAR_PATTERN.test(lowered) || CV_SIGNAL_WORDS.some((word) => lowered.includes(word));
  if (!hasSignal) {
    failures.push('no_cv_signal');
  }

  return {
    usable: failures.length === 0,
    failures,
    stats: {
      characters,
      letters,
      // One decimal: this is a log line, not a measurement.
      alphabeticRatio: Math.round(alphabeticRatio * 10) / 10,
    },
  };
}
