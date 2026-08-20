import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { assessCvText } from '../../src/agents/util/text.js';
import { EXTRACTION_ERROR_CODES, assessTextLayer, extractDocumentText } from '../../src/extraction/index.js';

/**
 * The handoff to `agents/util/text.js`, asserted end to end.
 *
 * Plan section 5.5 splits ownership between two checks and calls the overlap
 * intentional. This file is where that claim is tested rather than asserted:
 * what does each guard actually catch, and is there anything that gets past
 * both?
 *
 * The division, restated so the tests below have something to fail against:
 *
 * - **This layer** owns the *structural* question - characters per page - and
 *   it is the only one that can, because the page count does not survive into
 *   the text.
 * - **`assessCvText`** owns the *content* question - enough characters, enough
 *   letters, one CV-shaped signal - and it runs immediately before the first
 *   API call.
 *
 * The conclusion this file supports, and which the phase 3 report states
 * outright: **`assessCvText` needs no change.** It is not missing a signal. It
 * is being handed text that a structural check has already vetted, and the one
 * fact it cannot see is the one this layer refuses to pass on.
 */

/** @param {string} name */
function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url)));
}

describe('what extraction hands to assessCvText', () => {
  it('produces text the guard accepts, for every fixture that extracts', async () => {
    for (const name of ['clean.pdf', 'two-column.pdf', 'cv.docx', 'cv.txt']) {
      const { text } = await extractDocumentText({ bytes: fixture(name) });
      const assessment = assessCvText(text);

      expect(assessment.usable, `${name}: ${assessment.failures.join(', ')}`).toBe(true);
    }
  });

  it('hands over the structural facts the guard cannot compute for itself', async () => {
    // The two halves of what the worker should log when a candidate fails.
    // `assessCvText` reports characters, letters and an alphabetic ratio; only
    // this layer can report how many pages those characters came off.
    const { text, structure } = await extractDocumentText({ bytes: fixture('clean.pdf') });

    expect(structure).toEqual({
      pageCount: 2,
      characters: text.length,
      charactersPerPage: Math.round((text.length / 2) * 10) / 10,
      byteSize: fixture('clean.pdf').length,
    });
    expect(Object.keys(assessCvText(text).stats)).toEqual([
      'characters',
      'letters',
      'alphabeticRatio',
    ]);
  });

  it('stops the scanned PDF before the guard is ever consulted', async () => {
    // The cheaper of the two failures, and the earlier one. Nothing is
    // extracted, so no text reaches `assessCvText` and no token is spent.
    const error = await extractDocumentText({ bytes: fixture('scanned.pdf') }).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT);
  });
});

describe('the overlap between the two guards, and the gap between them', () => {
  it('catches the empty text layer twice, which is the intended redundancy', () => {
    // Plan section 5.5: two cheap checks that agree cost less than one check in
    // a file somebody later reorganises.
    expect(assessTextLayer({ characters: 0, pageCount: 1 }).imageOnly).toBe(true);
    expect(assessCvText('').usable).toBe(false);
  });

  it('catches a multi-page scan that assessCvText alone would pass', () => {
    // The case that justifies the split existing at all. Six pages of scan
    // whose text layer produced nothing but one running header per page: real
    // words, a year among them, and comfortably past the 200-character floor -
    // so `assessCvText` passes it, and would go on spending a token on a
    // document containing no CV.
    const runningHeader = 'Priya Ramanathan - Curriculum Vitae - 2024 - Confidential\n';
    const pageCount = 6;
    const survivingText = runningHeader.repeat(pageCount);

    expect(survivingText.length).toBeGreaterThan(200);
    expect(assessCvText(survivingText).usable).toBe(true);

    // Per page it is 58 characters, and only this layer can see that.
    expect(assessTextLayer({ characters: survivingText.length, pageCount }).imageOnly).toBe(true);
  });

  it('catches debris that the per-page check alone would pass', () => {
    // And the case that justifies the *other* half. A single page of a failed
    // text layer - ligature debris and punctuation, no prose - clears 100
    // characters per page comfortably and is worth nothing to a model.
    const debris = '/#*%-|.,;:'.repeat(40);

    expect(assessTextLayer({ characters: debris.length, pageCount: 1 }).imageOnly).toBe(false);
    expect(assessCvText(debris).failures).toContain('not_enough_letters');
  });

  it('lets a thin but genuine one-page CV through both', () => {
    // The failure neither guard may produce. Rejecting a real CV here looks
    // identical to a parsing bug from the recruiter's side, and plan section
    // 7-C's argument is that quietly dropping hard-to-parse candidates is a
    // discrimination pattern with a technical cause.
    const thin = [
      'Aisha Khan',
      'aisha.khan@example.com',
      'Backend engineer, six years, Node.js and PostgreSQL.',
      'EXPERIENCE: Kelpie Logistics, 2021 to present. Thistle Software, 2018 to 2021.',
      'EDUCATION: BSc Computing Science, University of Edinburgh, 2018.',
      'SKILLS: Node.js, PostgreSQL, Redis, AWS, Docker.',
    ].join('\n');

    expect(assessTextLayer({ characters: thin.length, pageCount: 1 }).imageOnly).toBe(false);
    expect(assessCvText(thin).usable).toBe(true);
  });
});
