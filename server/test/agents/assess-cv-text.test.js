import { describe, expect, it } from 'vitest';
import { CV_TEXT_THRESHOLDS, assessCvText } from '../../src/agents/util/text.js';
import { GOLDEN_CV_TEXT } from './fixtures/golden.js';

/**
 * The cheapest possible failure, from plan section 5.5.
 *
 * The bars are set to reject page furniture, not to reject short CVs. That
 * asymmetry is the whole design: a scanned PDF whose text layer yielded three
 * words costs nothing to refuse, while a genuinely thin one-page CV is a
 * candidate a recruiter should get to see - and rejecting one here would look
 * exactly like a parsing bug.
 */

describe('assessCvText', () => {
  it('accepts a real CV', () => {
    expect(assessCvText(GOLDEN_CV_TEXT)).toEqual({
      usable: true,
      failures: [],
      stats: { characters: 610, letters: 474, alphabeticRatio: 0.9 },
    });
  });

  it('rejects text too short to extract anything from', () => {
    const result = assessCvText('Page 1 of 3 - printed 2024');
    expect(result.usable).toBe(false);
    expect(result.failures).toContain('too_short');
  });

  it('rejects a failed text layer, which is punctuation and ligature debris', () => {
    // What a scanned PDF actually produces: characters, no prose.
    const debris = '/#*%-|.,;:'.repeat(40);
    const result = assessCvText(debris);

    expect(result.failures).toContain('not_enough_letters');
    expect(result.stats.alphabeticRatio).toBe(0);
  });

  it('rejects prose that is long and lettered but is not a CV', () => {
    const notACv = 'The quick brown fox jumps over the lazy dog again and again. '.repeat(10);
    const result = assessCvText(notACv);

    expect(result.failures).toEqual(['no_cv_signal']);
    expect(result.usable).toBe(false);
  });

  it('accepts a CV on a single signal, without needing a section header', () => {
    // Almost every CV carries a year, and that alone is enough. The signal list
    // is a smoke test against a random PDF, not a classifier - every word added
    // to it is another chance to reject a real CV that words things differently.
    const dateOnly = `${'Wrote software and led a small team. '.repeat(8)} 2019 to 2024.`;
    expect(assessCvText(dateOnly).usable).toBe(true);
  });

  it('treats anything that is not a string as an empty document', () => {
    for (const value of [null, undefined, 42, {}]) {
      const result = assessCvText(value);
      expect(result.usable).toBe(false);
      expect(result.failures).toEqual(['too_short', 'not_enough_letters', 'no_cv_signal']);
      // 0, not NaN. A NaN in a log line tells the reader nothing.
      expect(result.stats.alphabeticRatio).toBe(0);
    }
  });

  it('reports counts a log can carry, and no span of the document', () => {
    const result = assessCvText('Priya Ramanathan, priya@example.com');
    expect(Object.keys(result.stats)).toEqual(['characters', 'letters', 'alphabeticRatio']);
    expect(JSON.stringify(result)).not.toContain('Priya');
  });

  it('states its thresholds rather than hiding them in a conditional', () => {
    expect(CV_TEXT_THRESHOLDS.MIN_CHARACTERS).toBe(200);
    expect(CV_TEXT_THRESHOLDS.MIN_ALPHABETIC_RATIO).toBe(0.5);
  });

  it('is exactly at the boundary, not near it', () => {
    // 199 characters of CV-shaped prose fails; 200 passes. Stated as a test
    // because a threshold nobody has probed is a guess.
    const filler = 'experience in software 2019 ';
    const justUnder = filler.repeat(8).slice(0, CV_TEXT_THRESHOLDS.MIN_CHARACTERS - 1);
    const justOver = filler.repeat(8).slice(0, CV_TEXT_THRESHOLDS.MIN_CHARACTERS);

    expect(assessCvText(justUnder).failures).toContain('too_short');
    expect(assessCvText(justOver).failures).not.toContain('too_short');
  });
});
