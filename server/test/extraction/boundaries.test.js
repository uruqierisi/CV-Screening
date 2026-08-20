import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as extraction from '../../src/extraction/index.js';

/**
 * The constraints that define this layer, asserted rather than remembered -
 * the same discipline `test/agents/layer-boundaries.test.js` applies to the
 * agent layer, and for the same reason: a comment saying "do not import that
 * here" is a wish.
 *
 * Three rules, each with a cost attached to breaking it:
 *
 * 1. **No web framework, no database driver, no queue.** This layer is handed a
 *    Buffer. The moment it reads a file itself, it stops being testable from an
 *    array of bytes and starts needing a filesystem in every test.
 * 2. **No import from `src/agents/`.** The two layers answer different
 *    questions and run at different times, and coupling them would make either
 *    impossible to reason about alone. The redundancy between the scanned-PDF
 *    check and `assessCvText` is deliberate (plan section 5.5) and is
 *    *redundancy*, not a shared implementation.
 * 3. **One PDF dependency, in one file.** `unpdf` is the only third-party
 *    package here, and only `parsers/pdf.js` may know it exists - which is what
 *    makes replacing it a one-file change.
 */

const EXTRACTION_DIR = fileURLToPath(new URL('../../src/extraction', import.meta.url));

/** The one file allowed to know a PDF library exists. */
const PDF_BOUNDARY_FILE = 'parsers/pdf.js';

/**
 * @param {string} directory
 * @returns {string[]} every .js file under it, recursively
 */
function listJsFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return listJsFiles(full);
    }
    return full.endsWith('.js') ? [full] : [];
  });
}

const EXTRACTION_FILES = listJsFiles(EXTRACTION_DIR);

/** @param {string} file @returns {string} path relative to src/extraction, with / separators */
function relative(file) {
  return file.slice(EXTRACTION_DIR.length + 1).replace(/\\/g, '/');
}

/**
 * Every module specifier imported for its runtime value. JSDoc `import('...')`
 * type references are excluded on purpose: they are erased, they cost nothing
 * at runtime, and forbidding them would mean the layer could not describe the
 * shape of the data it handles.
 *
 * @param {string} source
 * @returns {string[]}
 */
function runtimeImports(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...withoutComments.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm)].map(
    (match) => match[1],
  );
}

describe('the extraction layer imports nothing it should not', () => {
  it('finds the files it is supposed to be checking', () => {
    // Guards the walker: an empty list would make every assertion below vacuous.
    expect(EXTRACTION_FILES.length).toBeGreaterThanOrEqual(9);
    expect(EXTRACTION_FILES.some((file) => file.endsWith('extract-document-text.js'))).toBe(true);
    expect(EXTRACTION_FILES.some((file) => file.endsWith('pdf.js'))).toBe(true);
  });

  it('imports exactly one third-party package, and only in the PDF parser', () => {
    /** @type {Map<string, string[]>} */
    const external = new Map();

    for (const file of EXTRACTION_FILES) {
      for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
          external.set(specifier, [...(external.get(specifier) ?? []), relative(file)]);
        }
      }
    }

    // `unpdf` for PDF text extraction, and nothing else. DOCX is a ZIP read by
    // `zip.js` over `node:zlib`; TXT is `TextDecoder`.
    expect([...external.keys()]).toEqual(['unpdf']);
    expect(external.get('unpdf')).toEqual([PDF_BOUNDARY_FILE]);
  });

  it('imports no web framework, database driver or queue', () => {
    // This layer takes a Buffer. It does not read files, open sockets or know
    // what a request is, which is what keeps every test in this directory a
    // pure function call over bytes.
    const forbidden = ['fastify', 'pg', 'bullmq', 'ioredis', 'express', 'node:fs', 'node:net'];

    for (const file of EXTRACTION_FILES) {
      const specifiers = runtimeImports(readFileSync(file, 'utf8'));
      for (const banned of forbidden) {
        expect(specifiers, `${relative(file)} imports ${banned}`).not.toContain(banned);
      }
    }
  });

  it('imports nothing from the agent layer', () => {
    // Plan section 5.5 splits the ownership deliberately, and the redundancy
    // between this layer's scanned-PDF check and `assessCvText` is the point of
    // the split rather than duplication to be factored out.
    for (const file of EXTRACTION_FILES) {
      for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
        expect(specifier, relative(file)).not.toContain('agents/');
      }
    }
  });

  it('exposes one entry point carrying the whole contract', () => {
    // Mirrors `src/agents/index.js`: a reader should be able to see a layer's
    // surface in one file, and phase 4 should never need to reach into a
    // parser.
    expect(Object.keys(extraction).sort()).toEqual([
      'EMPTY_FILE_MESSAGE',
      'EXTRACTION_ERROR_CODES',
      'EmptyDocumentError',
      'ExtractionError',
      'ExtractionFailedError',
      'MIME_TYPES',
      'MIN_CHARACTERS_PER_PAGE',
      'SCANNED_PDF_MESSAGE',
      'SUPPORTED_MIME_TYPES',
      'UNSUPPORTED_TYPE_MESSAGE',
      'UnsupportedFileTypeError',
      'assessTextLayer',
      'extractDocumentText',
      'sniffMimeType',
    ]);
  });

  it('exposes exactly the plan section 2 allowlist and no more', () => {
    expect([...extraction.SUPPORTED_MIME_TYPES]).toEqual([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ]);
  });

  it('gives every error a code the plan already defines', () => {
    // No invented codes. Two are worker-side candidate codes from section 5.4
    // and one is the API code from section 3.
    expect(Object.values(extraction.EXTRACTION_ERROR_CODES).sort()).toEqual([
      'EMPTY_DOCUMENT',
      'EXTRACTION_FAILED',
      'UNSUPPORTED_FILE_TYPE',
    ]);
  });
});
