import { describe, expect, it } from 'vitest';
import {
  containsNormalized,
  containsTokenSequence,
  equalsExact,
  normalizeForMatch,
  normalizeWhitespace,
  tokenize,
} from '../../src/agents/util/text.js';

/**
 * One definition of "the same text" for the whole agent layer. Two private
 * normalizers would drift, and the drift would surface as a candidate eliminated
 * by a rule whose skill the evidence checker considered matched - a bug nobody
 * would find by reading either file on its own.
 */

describe('normalizeWhitespace', () => {
  it('collapses every kind of whitespace run and trims', () => {
    expect(normalizeWhitespace('  a\t\tb\n\nc  ')).toBe('a b c');
    expect(normalizeWhitespace('a b')).toBe('a b');
  });

  it('removes zero-width characters and byte-order marks', () => {
    expect(normalizeWhitespace('Post​greSQL')).toBe('PostgreSQL');
    expect(normalizeWhitespace('﻿hello')).toBe('hello');
  });

  it('leaves case alone', () => {
    expect(normalizeWhitespace('PostgreSQL')).toBe('PostgreSQL');
  });
});

describe('normalizeForMatch', () => {
  it('folds case', () => {
    expect(normalizeForMatch('PostgreSQL')).toBe('postgresql');
  });

  it('folds every unicode dash onto the ASCII hyphen', () => {
    for (const dash of ['‐', '‑', '‒', '–', '—', '―', '−', '－']) {
      expect(normalizeForMatch(`ci${dash}cd`)).toBe('ci-cd');
    }
  });

  it('folds typographic quotes', () => {
    expect(normalizeForMatch('‘quoted’')).toBe("'quoted'");
    expect(normalizeForMatch('“quoted”')).toBe('"quoted"');
  });

  it('applies compatibility normalization', () => {
    expect(normalizeForMatch('ﬁle')).toBe('file');
  });
});

describe('tokenize', () => {
  it('splits on punctuation and whitespace', () => {
    expect(tokenize('Node.js, PostgreSQL; Redis')).toEqual(['node', 'js', 'postgresql', 'redis']);
  });

  it('keeps + and # inside a token, because they are part of the language name', () => {
    expect(tokenize('C++ and C#')).toEqual(['c++', 'and', 'c#']);
  });

  it('returns an empty list for text with nothing in it', () => {
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('---')).toEqual([]);
  });

  it('handles non-latin scripts as tokens rather than dropping them', () => {
    expect(tokenize('Python 中文 データ')).toEqual(['python', '中文', 'データ']);
  });
});

describe('containsTokenSequence', () => {
  it('matches a whole token', () => {
    expect(containsTokenSequence('PostgreSQL administration', 'postgresql')).toBe(true);
  });

  it('matches a contiguous run of tokens', () => {
    expect(containsTokenSequence('senior amazon web services architect', 'Amazon Web Services')).toBe(
      true,
    );
  });

  it('does not match tokens that are not contiguous', () => {
    expect(containsTokenSequence('amazon and other web services', 'amazon web services')).toBe(false);
  });

  it('does not match across a token boundary', () => {
    expect(containsTokenSequence('JavaScript', 'Java')).toBe(false);
    expect(containsTokenSequence('Postgres', 'PostgreSQL')).toBe(false);
  });

  it('matches at the end of the haystack', () => {
    expect(containsTokenSequence('experience with kubernetes', 'kubernetes')).toBe(true);
  });

  it('is false when the needle is longer than the haystack', () => {
    expect(containsTokenSequence('go', 'go lang expert')).toBe(false);
  });

  it('matches nothing for an empty needle', () => {
    // A requirement that specifies nothing is not satisfied by everything.
    expect(containsTokenSequence('anything at all', '')).toBe(false);
    expect(containsTokenSequence('anything at all', '  ')).toBe(false);
  });
});

describe('equalsExact', () => {
  it('is case-sensitive', () => {
    expect(equalsExact('PostgreSQL', 'postgresql')).toBe(false);
    expect(equalsExact('PostgreSQL', 'PostgreSQL')).toBe(true);
  });

  it('forgives surrounding and repeated whitespace only', () => {
    expect(equalsExact('  PostgreSQL ', 'PostgreSQL')).toBe(true);
    expect(equalsExact('Amazon  Web   Services', 'Amazon Web Services')).toBe(true);
  });
});

describe('containsNormalized', () => {
  it('finds a substring after folding invisible differences', () => {
    expect(containsNormalized('Built the — pipeline', 'built the - pipeline')).toBe(true);
    expect(containsNormalized('Built   the\npipeline', 'Built the pipeline')).toBe(true);
  });

  it('does not find text that is not there', () => {
    expect(containsNormalized('Built the pipeline', 'built a pipeline')).toBe(false);
  });

  it('finds nothing for an empty needle', () => {
    expect(containsNormalized('Built the pipeline', '')).toBe(false);
    expect(containsNormalized('Built the pipeline', '​')).toBe(false);
  });

  it('matches mid-token, unlike the token matcher', () => {
    // Deliberate difference: this backs evidence verification, where the claim is
    // that a span was copied out of the source, not that a term appears in it.
    expect(containsNormalized('JavaScript', 'java')).toBe(true);
  });
});
