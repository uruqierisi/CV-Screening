import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildAllFixtures } from './fixtures/build-documents.js';

/**
 * The fixtures are committed binaries, which means two things have to be true
 * and neither is self-evident: the generator has to be deterministic, and what
 * is on disk has to be what the generator produces.
 *
 * Without the second check, a fixture edited by hand - or regenerated from a
 * modified builder and then forgotten - would drift from the code that claims
 * to describe it, and every test reading it would be asserting against a file
 * nobody can explain.
 */

/** @param {string} name */
function committed(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url)));
}

/**
 * The same file as a reviewer sees it. `samples/` carries copies of these five
 * fixtures so that the sample CVs are one directory off the repository root
 * rather than four levels into a test tree.
 *
 * @param {string} name
 */
function sample(name) {
  return readFileSync(fileURLToPath(new URL(`../../../samples/${name}`, import.meta.url)));
}

const EXPECTED_FIXTURES = ['clean.pdf', 'two-column.pdf', 'scanned.pdf', 'cv.docx', 'cv.txt'];

describe('the document fixtures', () => {
  it('builds the five files the phase calls for', () => {
    expect(Object.keys(buildAllFixtures()).sort()).toEqual([...EXPECTED_FIXTURES].sort());
  });

  it('generates byte-identical output on every run', () => {
    // No timestamps, no random ids, no compression level left to a default.
    // A fixture that changes when nothing changed is a fixture nobody trusts.
    const first = buildAllFixtures();
    const second = buildAllFixtures();

    for (const name of EXPECTED_FIXTURES) {
      expect(first[name].equals(second[name])).toBe(true);
    }
  });

  it('matches what is committed to the repository, byte for byte', () => {
    // The check that makes `npm run fixtures:documents` meaningful. If this
    // fails, either somebody edited a fixture by hand or somebody changed the
    // builder and did not regenerate.
    const built = buildAllFixtures();

    for (const name of EXPECTED_FIXTURES) {
      expect(committed(name).equals(built[name])).toBe(true);
    }
  });

  it('matches the reviewer-facing copies in samples/, byte for byte', () => {
    // `samples/README.md` tells a reviewer these files are the parser fixtures,
    // and documents what each one demonstrates - the two-column interleave and
    // the scanned-PDF failure among them. A copy that drifted from the fixture
    // would make that documentation describe a file nobody is uploading, and
    // the drift would be invisible: both files still parse, just differently.
    const built = buildAllFixtures();

    for (const name of EXPECTED_FIXTURES) {
      expect(sample(name).equals(built[name]), name).toBe(true);
    }
  });

  it('keeps every fixture small enough to belong in a repository', () => {
    for (const [name, bytes] of Object.entries(buildAllFixtures())) {
      expect(bytes.length, name).toBeLessThan(8 * 1024);
    }
  });

  it('writes real files of the type their name claims', () => {
    // Cheap, and it catches the failure where a generator silently produces an
    // empty buffer and every downstream test passes for the wrong reason.
    expect(committed('clean.pdf').subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(committed('two-column.pdf').subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(committed('scanned.pdf').subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(committed('cv.docx').subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(committed('cv.txt').toString('utf8')).toContain('AISHA KHAN');
  });

  it('writes a text file with the CRLF endings a real Windows export has', () => {
    // The fixture has to carry the problem, or the normalization it exercises
    // is untested.
    expect(committed('cv.txt').includes(Buffer.from('\r\n'))).toBe(true);
  });
});
