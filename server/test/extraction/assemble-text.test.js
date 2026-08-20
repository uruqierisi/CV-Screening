import { describe, expect, it } from 'vitest';

import {
  PAGE_SEPARATOR,
  assembleDocumentText,
  assemblePageText,
} from '../../src/extraction/assemble-text.js';

/**
 * The arguable half of PDF extraction, exercised with hand-written items rather
 * than PDFs - which is why it lives in its own module.
 *
 * The items here are shaped exactly as pdf.js produces them, including the two
 * behaviours the assembler leans on: `hasEOL` on the item that ends a line, and
 * a synthesised whitespace-only item between two items that are far apart
 * horizontally.
 */

describe('assemblePageText', () => {
  it('joins runs on one line and breaks where pdf.js says the line ended', () => {
    const items = [
      { str: 'Senior Backend Engineer', hasEOL: false },
      { str: ', ', hasEOL: false },
      { str: 'Northwind Payments', hasEOL: true },
      { str: 'January 2019 - present', hasEOL: false },
    ];

    expect(assemblePageText(items)).toBe(
      'Senior Backend Engineer, Northwind Payments\nJanuary 2019 - present',
    );
  });

  it('keeps the synthesised gap between two items far apart on the same line', () => {
    // A right-aligned date gutter. pdf.js inserts the space; dropping
    // whitespace-only items would glue "Engineer" to "2019".
    const items = [
      { str: 'Senior Engineer', hasEOL: false },
      { str: ' ', hasEOL: false },
      { str: '2019 - 2024', hasEOL: true },
    ];

    expect(assemblePageText(items)).toBe('Senior Engineer 2019 - 2024');
  });

  it('collapses runs of spaces inside a line but never the line breaks', () => {
    // Newlines are the only structure a CV has left as plain text - they are
    // what keeps an employer on its own line, separate from the dates below it.
    const items = [
      { str: 'Skills:      Node.js,   PostgreSQL', hasEOL: true },
      { str: '\t Redis', hasEOL: true },
      { str: 'Docker', hasEOL: false },
    ];

    expect(assemblePageText(items)).toBe('Skills: Node.js, PostgreSQL\nRedis\nDocker');
  });

  it('skips marked-content items, which carry structure rather than glyphs', () => {
    const items = [
      { type: 'beginMarkedContent' },
      { str: 'Priya Ramanathan', hasEOL: true },
      { type: 'endMarkedContent' },
      { str: 'London', hasEOL: false },
    ];

    expect(assemblePageText(items)).toBe('Priya Ramanathan\nLondon');
  });

  it('returns an empty string for a page with no text items at all', () => {
    // What a scanned page produces, and the input the scanned-PDF check is
    // built on.
    expect(assemblePageText([])).toBe('');
  });

  it('trims the leading and trailing whitespace a page picks up from its margins', () => {
    const items = [
      { str: '   ', hasEOL: true },
      { str: 'Priya Ramanathan', hasEOL: true },
      { str: '  ', hasEOL: true },
    ];

    expect(assemblePageText(items)).toBe('Priya Ramanathan');
  });
});

describe('assembleDocumentText', () => {
  it('separates pages with a blank line', () => {
    expect(assembleDocumentText(['EXPERIENCE', 'EDUCATION'])).toBe(
      `EXPERIENCE${PAGE_SEPARATOR}EDUCATION`,
    );
  });

  it('drops empty pages rather than emitting separators for them', () => {
    // A scanned CV yields a run of empty pages, and a document made of nothing
    // but separators would read to the character count as content - which is
    // exactly the check that has to catch it.
    expect(assembleDocumentText(['', '', ''])).toBe('');
    expect(assembleDocumentText(['EXPERIENCE', '', 'EDUCATION'])).toBe(
      `EXPERIENCE${PAGE_SEPARATOR}EDUCATION`,
    );
  });
});
