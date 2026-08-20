import { describe, expect, it } from 'vitest';

import { MIN_CHARACTERS_PER_PAGE } from '../../src/extraction/constants.js';
import { assessTextLayer } from '../../src/extraction/text-layer.js';

/**
 * The scanned-PDF judgement from plan section 7-F, which is the one decision in
 * the system that needs a fact only the extraction layer holds.
 *
 * The bar is deliberately generous, and the asymmetry is the argument: a false
 * positive tells a recruiter to re-upload a file that was fine, while a false
 * negative costs nothing at all, because `assessCvText` runs next with a
 * 200-character floor of its own.
 */

describe('assessTextLayer', () => {
  it('passes a real CV page', () => {
    expect(assessTextLayer({ characters: 3200, pageCount: 2 })).toEqual({
      imageOnly: false,
      threshold: MIN_CHARACTERS_PER_PAGE,
      stats: { characters: 3200, pageCount: 2, charactersPerPage: 1600 },
    });
  });

  it('flags a scan, which yields nothing at all', () => {
    expect(assessTextLayer({ characters: 0, pageCount: 3 }).imageOnly).toBe(true);
  });

  it('flags a multi-page scan whose only text is a running header', () => {
    // The case that makes this a *per-page* rule rather than a total. 540
    // characters over six pages is page furniture, and it clears every absolute
    // character floor `assessCvText` could apply - which is precisely why that
    // function cannot make this call.
    expect(assessTextLayer({ characters: 540, pageCount: 6 }).imageOnly).toBe(true);
  });

  it('passes the same 540 characters when they are on one page', () => {
    // The same string, a different document. A thin one-page CV is a candidate
    // a recruiter should get to see.
    expect(assessTextLayer({ characters: 540, pageCount: 1 }).imageOnly).toBe(false);
  });

  it('treats the threshold as a floor the document has to reach', () => {
    const justUnder = assessTextLayer({ characters: MIN_CHARACTERS_PER_PAGE - 1, pageCount: 1 });
    const exactly = assessTextLayer({ characters: MIN_CHARACTERS_PER_PAGE, pageCount: 1 });

    expect(justUnder.imageOnly).toBe(true);
    expect(exactly.imageOnly).toBe(false);
  });

  it('treats a document with no pages as image-only rather than dividing by zero', () => {
    const verdict = assessTextLayer({ characters: 0, pageCount: 0 });

    expect(verdict.imageOnly).toBe(true);
    // 0, not NaN. A NaN in a log line tells the reader nothing, and "0
    // characters over 0 pages is fine" is exactly the arithmetic that would
    // pass a broken file through to the model.
    expect(verdict.stats.charactersPerPage).toBe(0);
  });

  it('rounds the reported rate to one decimal, because it is a log line', () => {
    expect(assessTextLayer({ characters: 1000, pageCount: 3 }).stats.charactersPerPage).toBe(333.3);
  });

  it('reports the threshold it applied, so a log line explains itself', () => {
    // Without this a reader has to find the constant to know whether 84 was
    // close or nowhere near.
    expect(assessTextLayer({ characters: 84, pageCount: 1 }).threshold).toBe(
      MIN_CHARACTERS_PER_PAGE,
    );
  });
});
