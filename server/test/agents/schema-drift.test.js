import { describe, expect, it } from 'vitest';
import { toOutputFormat } from '../../src/agents/client/anthropic-client.js';
import {
  EXTRACTED_LOCATION_FIELDS,
  extractedProfileSchema,
  verifiedProfileSchema,
} from '../../src/agents/schemas/profile.schema.js';

/**
 * **The seam test for the wire/stored split.**
 *
 * Splitting the profile into a schema the model fills in and a schema the system
 * stores was the right call - the two are answering different questions, and the
 * API's schema budgets only apply to one of them. It also created a failure
 * surface that did not exist while there was one schema: **a field added to one
 * and forgotten on the other simply never arrives.**
 *
 * That failure is silent in every way that matters. The extraction validates,
 * `normalize-profile.js` is a hand-written field list and quietly does not
 * mention it, the stored profile validates because the field is nullable, the
 * dashboard renders an empty cell, and the evaluation model rates a candidate on
 * a profile with a hole in it. Nothing throws. Nothing is logged. The only
 * symptom is slightly worse hiring decisions.
 *
 * So the two schemas are compared field for field, both directions, and the
 * comparison is the test rather than a convention in a header comment.
 *
 * ## What the comparison allows
 *
 * Exactly one thing, and it is written out as a literal below: the fields the
 * **stored** shape has that the wire deliberately does not offer. Every one of
 * them is set by code, and the point of leaving it off the wire is that the
 * model then has nowhere to put a value for it - the same argument that keeps
 * `matchScore` out of the evaluation schema.
 *
 * A literal, not a rule, because dropping a new field has to be a visible edit
 * to this list with a reviewer attached. A predicate ("anything the model cannot
 * know") would quietly absorb the next omission, which is the whole failure this
 * file exists to prevent.
 *
 * ## What it does not check
 *
 * Not types, and not how absence is spelled. `.optional()` on the wire against
 * `.nullable()` in storage is the entire point of the split, and
 * `normalize-profile.test.js` is where the value-for-value translation is
 * asserted. This file checks one thing: **the same fields exist on both sides.**
 */

/**
 * The fields `verifiedProfileSchema` has and `extractedProfileSchema` does not.
 *
 * Both are written by code after the model has answered, and both are deliberate
 * omissions from the wire contract rather than oversights:
 *
 * - `computedYearsExperience` - derived from the work-history dates by
 *   `compute-experience.js`, with overlapping employment merged. The elimination
 *   rules read this and never the model's `statedYearsExperience`. If the model
 *   could send it, the number a candidate is eliminated on would be the number
 *   the CV claimed about itself.
 * - `skills[].evidenceVerified` - set by `verify-evidence.js` from a substring
 *   match against the source CV. It is the one claim in the system a machine can
 *   falsify, and a model that could assert its own quote had been verified would
 *   falsify nothing.
 *
 * @type {readonly string[]}
 */
const STORED_ONLY_FIELDS = Object.freeze([
  'computedYearsExperience',
  'skills[].evidenceVerified',
]);

/**
 * Every field in a generated JSON Schema, by dotted path, with `[]` marking a
 * step through an array.
 *
 * The JSON Schema rather than the zod object, because it is the same conversion
 * the wire uses and it flattens away the wrappers - optional, nullable, effects
 * - that this comparison is deliberately blind to. A nullable object arrives as
 * an `anyOf` of the object and `null`, so both branches are walked.
 *
 * @param {unknown} node
 * @param {string} [prefix]
 * @param {string[]} [found]
 * @returns {string[]}
 */
function fieldPaths(node, prefix = '', found = []) {
  if (node === null || typeof node !== 'object') {
    return found;
  }

  const schema = /** @type {Record<string, any>} */ (node);
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];

  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object') {
      continue;
    }

    if (branch.properties !== null && typeof branch.properties === 'object') {
      for (const [key, value] of Object.entries(branch.properties)) {
        const path = `${prefix}${key}`;
        found.push(path);
        fieldPaths(value, `${path}.`, found);
      }
    }

    if (branch.items !== undefined) {
      fieldPaths(branch.items, `${prefix.replace(/\.$/, '')}[].`, found);
    }
  }

  return found;
}

/**
 * The one difference in *shape* the comparison is asked to see past.
 *
 * `location` is three sibling strings on the wire and one nested object in
 * storage. That was a union-budget decision and nothing else - nested, it cost
 * five of the sixteen unions the API allows - so it must not read as a
 * difference in the field set.
 *
 * Two things are translated: each flat field becomes its nested path, and the
 * container itself is added, because storage has a `location` key and the wire
 * has no container at all. The mapping comes from `EXTRACTED_LOCATION_FIELDS`,
 * the same map `normalize-profile.js` re-nests with, so a fourth location field
 * has to be declared there before this test will accept it - exactly the
 * coupling wanted.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
function asStoredPaths(paths) {
  const nested = paths.map((path) => {
    const key = EXTRACTED_LOCATION_FIELDS[path];
    return key === undefined ? path : `location.${key}`;
  });

  return [...nested, 'location'];
}

/** @param {import('zod').ZodTypeAny} schema */
const pathsOf = (schema) => fieldPaths(toOutputFormat(schema).schema);

describe('the walker this comparison rests on', () => {
  it('names every field, at every depth, marking array steps', () => {
    // A walker that returned nothing would make the comparison below pass
    // against any pair of schemas at all.
    const generated = {
      type: 'object',
      properties: {
        top: { type: 'string' },
        nested: {
          anyOf: [
            { type: 'object', properties: { inner: { type: 'string' } } },
            { type: 'null' },
          ],
        },
        list: {
          type: 'array',
          items: { type: 'object', properties: { entry: { type: 'string' } } },
        },
      },
    };

    expect(fieldPaths(generated)).toEqual([
      'top',
      'nested',
      'nested.inner',
      'list',
      'list[].entry',
    ]);
  });
});

describe('the wire schema and the stored schema describe the same profile', () => {
  const wire = asStoredPaths(pathsOf(extractedProfileSchema));
  const stored = pathsOf(verifiedProfileSchema);

  it('has nothing in storage that the model was never asked for', () => {
    // The direction that catches the real bug: somebody adds a field to
    // `profileSchema` and to the dashboard, and the model is never asked to
    // fill it, so it is null for every candidate forever.
    const missingFromWire = stored.filter((path) => !wire.includes(path));

    expect(missingFromWire.sort()).toEqual([...STORED_ONLY_FIELDS].sort());
  });

  it('has nothing on the wire that storage would throw away', () => {
    // The other direction, which fails louder in practice - `profileSchema` is
    // strict, so an extra wire field would blow up in `normalize-profile.js` -
    // but is worth asserting here so that both halves of the contract are stated
    // in one place.
    const missingFromStorage = wire.filter((path) => !stored.includes(path));

    expect(missingFromStorage).toEqual([]);
  });

  it('accounts for every field on both sides, so neither list can be empty', () => {
    // Guards the two assertions above against a walker that silently returned
    // nothing for one schema: two empty lists would satisfy both.
    expect(wire.length).toBeGreaterThan(20);
    expect(stored).toEqual(expect.arrayContaining(['skills[].name', 'location.countryCode']));
    expect(wire).toEqual(expect.arrayContaining(['skills[].name', 'location.countryCode']));
  });
});
