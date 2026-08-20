/**
 * Writes the committed fixture files.
 *
 * Run with `npm run fixtures:documents` from `server/`. Committing the output
 * is the point - the parser has to be exercised against real bytes on a real
 * disk - but the bytes are reproducible, and `fixtures.test.js` fails if what
 * is committed is not what this script produces.
 *
 * Regenerate when `build-documents.js` changes and at no other time.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAllFixtures } from './build-documents.js';

const OUTPUT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'documents');

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

for (const [name, bytes] of Object.entries(buildAllFixtures())) {
  const path = join(OUTPUT_DIRECTORY, name);
  writeFileSync(path, bytes);
  process.stdout.write(`${name.padEnd(16)} ${String(bytes.length).padStart(7)} bytes\n`);
}
