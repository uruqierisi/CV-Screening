import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { extractDocumentText } from '../../src/extraction/index.js';
import { parsePdf } from '../../src/extraction/parsers/pdf.js';
import { buildTextPdf, buildTwoColumnRuns } from './fixtures/build-documents.js';

/**
 * The two-column CV, which is the case most likely to produce garbage - and the
 * one the plan's known-limitations list is going to have to be honest about.
 *
 * This file does not assert that the output is *good*. It asserts what the
 * parser actually does, character for character, so that the behaviour is a
 * recorded fact rather than an assumption. If it is wrong, it is wrong visibly
 * and in one place.
 *
 * The experiment: the same ten rows of text, at the same coordinates on the same
 * page, emitted into the content stream in two different orders. Nothing about
 * the *layout* differs between the two PDFs - only the sequence of operators.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/documents/two-column.pdf', import.meta.url));

describe('a two-column PDF', () => {
  it('interleaves the columns when the producer emits the page row by row', async () => {
    const result = await extractDocumentText({ bytes: readFileSync(FIXTURE) });

    // This is the finding, written out in full. Line 1 of the left column is
    // followed on the same line by line 1 of the right column: a job title
    // butted against a skill, a date range against a technology. It is what a
    // CV built on a two-column *table* extracts to, and that is one of the most
    // common CV templates there is.
    expect(result.text).toBe(
      [
        'EXPERIENCE SKILLS',
        'Senior Backend Engineer Node.js',
        'Northwind Payments PostgreSQL',
        'January 2019 - present Redis',
        'Led the ledger migration Docker',
        'Backend Engineer EDUCATION',
        'Griffin Health BSc Computer Science',
        'March 2016 - December 2018 Manchester, 2015',
        'Built appointment scheduling CONTACT',
        'for forty clinics priya@example.com',
      ].join('\n'),
    );
  });

  it('extracts the same page cleanly when the producer emits it column by column', async () => {
    // Same rows, same coordinates, same fixture generator - only the order of
    // the drawing operators changes. Built in memory rather than committed,
    // because its whole job is to be the control in the comparison above.
    const columnMajor = buildTextPdf(buildTwoColumnRuns('column-major'));
    const { text } = await parsePdf(columnMajor);

    expect(text).toBe(
      [
        'EXPERIENCE',
        'Senior Backend Engineer',
        'Northwind Payments',
        'January 2019 - present',
        'Led the ledger migration',
        'Backend Engineer',
        'Griffin Health',
        'March 2016 - December 2018',
        'Built appointment scheduling',
        'for forty clinics',
        'SKILLS',
        'Node.js',
        'PostgreSQL',
        'Redis',
        'Docker',
        'EDUCATION',
        'BSc Computer Science',
        'Manchester, 2015',
        'CONTACT',
        'priya@example.com',
      ].join('\n'),
    );
  });

  it('proves the two PDFs differ only in emission order, not in layout', async () => {
    // Without this, the comparison above proves nothing: two files that put ink
    // in different places would obviously extract differently. The claim being
    // made is stronger and more uncomfortable - identical pages, identical
    // pixels, and the extraction quality depends entirely on which tool wrote
    // the file.
    const rowMajor = buildTwoColumnRuns('row-major').flat();
    const columnMajor = buildTwoColumnRuns('column-major').flat();

    const key = (/** @type {{x: number, y: number, size: number, text: string}} */ run) =>
      `${run.x}:${run.y}:${run.size}:${run.text}`;

    expect(rowMajor.map(key).sort()).toEqual(columnMajor.map(key).sort());
    expect(rowMajor.map(key)).not.toEqual(columnMajor.map(key));
  });

  it('still reads as a CV to the guard that runs next, interleaved or not', async () => {
    // The consequence that matters for the product: interleaved text is degraded,
    // not rejected. It clears `assessCvText` and reaches the model, which is the
    // right outcome - plan section 7-C's argument is that quietly dropping
    // hard-to-parse CVs into the bottom tier is a discrimination pattern with a
    // technical cause. A bad extraction should produce a visible, defensible
    // rating, not a silent disappearance.
    const { text } = await extractDocumentText({ bytes: readFileSync(FIXTURE) });

    const { assessCvText } = await import('../../src/agents/util/text.js');
    expect(assessCvText(text).usable).toBe(true);
  });
});
