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
