import { describe, expect, it } from 'vitest';
import { extractProfile } from '../../src/agents/extraction/extract-profile.js';
import { evaluateCandidate } from '../../src/agents/evaluation/evaluate-candidate.js';
import {
  GOLDEN_CV_TEXT,
  GOLDEN_NOW_ISO,
  GOLDEN_PROFILE,
  GOLDEN_ROLE,
} from './fixtures/golden.js';

/**
 * **The test that would have caught both defects without spending a request.**
 *
 * ## What this file still owns, and what it stopped owning
 *
 * It owns the **evaluation** schema, which is now the only schema this system
 * sends. Extraction stopped sending one: the API's grammar compiler could not
 * compile it in a usable time even at 0 unions and 22 optionals - far under both
 * caps below - and the bisect that established that is in plan section 5.2. So
 * the extraction assertions here were not weakened, they were **retired**, and
 * asserting a budget on a schema that never leaves the process would have been
 * asserting a fiction.
 *
 * What replaced them is the assertion at the bottom of this file: extraction
 * sends no schema at all. That is now the fact worth guarding, because
 * accidentally reinstating one would not fail loudly - it would hang for two
 * minutes per candidate and look like a network problem, which is exactly how
 * this was found in the first place.
 *
 * The caps below remain real and remain the reason the evaluation schema is
 * shaped as it is, so the counters stay.
 *
 * ## The two caps
 *
 * The API compiles the JSON Schema in `output_config.format` into a decoding
 * grammar, and it enforces **two independent caps** on what it will compile. Two
 * live requests found them, one after the other:
 *
 * > `400 invalid_request_error` - "Schemas contains too many parameters with
 * > union types (32 parameters with type arrays or anyOf). This causes
 * > exponential compilation cost. Reduce the number of nullable or union-typed
 * > parameters (limit: 16 parameters with unions)."
 *
 * > `400 invalid_request_error` - "Schemas contains too many optional parameters
 * > (31), which would make grammar compilation inefficient. Reduce the number of
 * > optional parameters in your tool schemas (limit: 24)."
 *
 * The first was fixed by trading every `.nullable()` for `.optional()`, which
 * walked directly into the second: a union costs the grammar exponentially and
 * an optional costs it a branch, so **the caps are separate budgets and the
 * trade moves spend from one to the other**. Only a *required* field costs
 * neither.
 *
 * Both are **measurable** limits, which is the property that made them worth a
 * test - and it is the property the limit that actually stopped extraction does
 * not have. That one is invisible from outside, surfaces sometimes as a 400 and
 * sometimes as a hang, and no counter here would have predicted it. Recorded
 * plainly because it is the honest scope of this file: it catches the two caps
 * the API documents, not the compilation cost it does not.
 *
 * ## Why this file asserts both caps
 *
 * The brief that produced the first version of this file named one limit,
 * because one 400 had revealed one limit. That is the wrong unit: a test should
 * own the **class** of failure, not the instance of it. So both caps are counted
 * for every schema this system sends, and a third cap discovered next month gets
 * a third counter beside these two rather than a third outage.
 *
 * ## What is counted, and how
 *
 * Both counters walk the whole generated schema, not just its top-level
 * properties - the limits are on *parameters*, at any depth, and the counts that
 * produced the two 400s both included fields nested inside array items.
 *
 * - A **union** is a node carrying a `type` array, an `anyOf` or a `oneOf`,
 *   which is what the first message itself names.
 * - An **optional** is a property not listed in its own object's `required`
 *   array, which is what "optional parameter" means in a JSON Schema and
 *   therefore what the API is counting.
 *
 * The counters live here rather than in `src/`: they are a check *on* the system
 * rather than a part of it, and nothing at runtime has any use for them. Keeping
 * them out of the source tree also means the schema and the thing that measures
 * the schema cannot be brought back into agreement by one edit.
 *
 * ## The exact counts are asserted, not just the ceilings
 *
 * A field that pushes a schema *toward* a cap is then visible in a diff on the
 * day it lands rather than on the day it crosses. Changing an expected number is
 * a deliberate act with a reviewer attached; discovering a ceiling in production
 * is not.
 */

/** The API's own limits, quoted from the two messages above. Not policies of ours. */
const UNION_PARAMETER_LIMIT = 16;
const OPTIONAL_PARAMETER_LIMIT = 24;

/**
 * Every union-typed parameter in a generated JSON Schema, by path.
 *
 * @param {unknown} node
 * @param {string} [path]
 * @param {string[]} [found]
 * @returns {string[]} one entry per union-typed parameter, deepest included
 */
function unionParameters(node, path = '$', found = []) {
  if (node === null || typeof node !== 'object') {
    return found;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => unionParameters(item, `${path}[${index}]`, found));
    return found;
  }

  const schema = /** @type {Record<string, unknown>} */ (node);
  if (
    Array.isArray(schema.type) ||
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.oneOf)
  ) {
    found.push(path);
  }

  for (const [key, value] of Object.entries(schema)) {
    unionParameters(value, `${path}.${key}`, found);
  }

  return found;
}

/**
 * Every optional parameter in a generated JSON Schema, by path.
 *
 * Counted the way the API does: **a property is optional when its own object's
 * `required` array does not name it**, at every depth, through `items` as well
 * as `properties`. Nothing about the zod source is consulted - `.optional()`,
 * `.default()` and a `z.preprocess` wrapping an optional all reach the wire as
 * the same absence from `required`, and the wire is what is being measured.
 *
 * @param {unknown} node
 * @param {string} [path]
 * @param {string[]} [found]
 * @returns {string[]}
 */
function optionalParameters(node, path = '$', found = []) {
  if (node === null || typeof node !== 'object') {
    return found;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => optionalParameters(item, `${path}[${index}]`, found));
    return found;
  }

  const schema = /** @type {Record<string, unknown>} */ (node);
  const properties = schema.properties;

  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) {
        found.push(`${path}.properties.${key}`);
      }
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    optionalParameters(value, `${path}.${key}`, found);
  }

  return found;
}

/**
 * The JSON Schema one stage actually puts on the wire.
 *
 * Read off the request rather than by converting a schema this file imported, so
 * the test cannot drift from the call sites: if `extract-profile.js` ever points
 * at a different schema, this measures the different schema.
 *
 * The recording client answers nothing at all, and that is deliberate. Measuring
 * the request through a *successful* round trip would couple this test to the
 * response fixtures, and a schema change big enough to break a fixture would
 * make these assertions fail for the wrong reason - the one thing a canary must
 * not do. Whatever the call throws is discarded; only the request matters.
 *
 * Both methods are recorded, because which one a stage uses is itself part of
 * what this file now checks: `parse` means a schema went with the request and
 * `create` means none did.
 *
 * @param {(client: { messages: { parse: Function, create: Function } }) => Promise<unknown>} run
 * @returns {Promise<any>} the request params
 */
async function requestSentBy(run) {
  /** @type {any} */
  let request = null;

  /** @param {any} params */
  const record = (params) => {
    request = params;
    return Promise.reject(new Error('recorded'));
  };

  const client = { messages: { parse: record, create: record } };

  await run(client).catch(() => undefined);

  expect(request, 'no request was made, so there is nothing to measure').not.toBeNull();
  return request;
}

/** @returns {Promise<any>} */
const extractionRequest = () =>
  requestSentBy((client) =>
    extractProfile({ client, cvText: GOLDEN_CV_TEXT, now: new Date(GOLDEN_NOW_ISO) }),
  );

/**
 * @param {object} [role]
 * @returns {Promise<Record<string, unknown>>}
 */
const evaluationSchema = async (role = GOLDEN_ROLE) => {
  const request = await requestSentBy((client) =>
    evaluateCandidate({ client, role, profile: GOLDEN_PROFILE }),
  );
  return request.output_config.format.schema;
};

describe('the counters themselves', () => {
  // Guards the walkers. A counter that silently returned 0 would make every
  // assertion below vacuous and would have missed both original defects just as
  // thoroughly as having no test at all.
  const nested = {
    type: 'object',
    properties: {
      top: { type: ['string', 'null'] },
      kept: { type: 'string' },
      wrapped: {
        anyOf: [
          {
            type: 'object',
            properties: { deep: { type: ['number', 'null'] } },
          },
          { type: 'null' },
        ],
      },
      list: {
        type: 'array',
        items: {
          type: 'object',
          properties: { inner: { oneOf: [{}, {}] }, named: { type: 'string' } },
          required: ['named'],
        },
      },
    },
    required: ['kept', 'list'],
  };

  it('counts unions at every depth', () => {
    expect(unionParameters(nested)).toEqual([
      '$.properties.top',
      '$.properties.wrapped',
      '$.properties.wrapped.anyOf[0].properties.deep',
      '$.properties.list.items.properties.inner',
    ]);
  });

  it('counts optionals at every depth, through array items', () => {
    // `kept`, `list` and `named` are required and cost nothing. Everything else
    // is a property its object's `required` does not name.
    expect(optionalParameters(nested)).toEqual([
      '$.properties.top',
      '$.properties.wrapped',
      '$.properties.wrapped.anyOf[0].properties.deep',
      '$.properties.list.items.properties.inner',
    ]);
  });

  it('counts a property as required only when its own object requires it', () => {
    // The two budgets are independent, and this is the shape that proves the
    // optional counter is not just the union counter under another name: a
    // required nullable costs a union and no optional, and an optional
    // non-nullable costs an optional and no union.
    const mixed = {
      type: 'object',
      properties: {
        requiredNullable: { type: ['string', 'null'] },
        optionalPlain: { type: 'string' },
      },
      required: ['requiredNullable'],
    };

    expect(unionParameters(mixed)).toEqual(['$.properties.requiredNullable']);
    expect(optionalParameters(mixed)).toEqual(['$.properties.optionalPlain']);
  });
});

describe('extraction sends no schema at all', () => {
  it('puts no format on the request and takes the method that has none', async () => {
    const request = await extractionRequest();

    // The whole change, in two assertions. A schema back on this request would
    // not fail loudly - it would hang for two minutes per candidate and read as
    // a network fault - so the absence is asserted rather than assumed.
    expect(request.output_config).not.toHaveProperty('format');
    expect(request).not.toHaveProperty('output_format');

    // `effort` survives the change, and that matters: it is a property of
    // `output_config` in its own right, not of the schema, and `low` on a
    // transcription task is the biggest cost lever in the system.
    expect(request.output_config.effort).toBe('low');
  });

  it('leaves nothing for the counters to measure, which is the point', async () => {
    const request = await extractionRequest();

    // Stated as a test rather than as a comment: there is no generated schema on
    // this call, so neither budget applies to it and neither is asserted for it
    // any more. The zod schema still validates the response - that guarantee
    // never came from the wire - and `schema-drift.test.js` still holds the two
    // profile shapes together.
    expect(request.output_config.format).toBeUndefined();
  });
});

describe('the two budgets on every schema this system sends', () => {
  it('sends an evaluation schema with two unions, both of which earn their place', async () => {
    const unions = unionParameters(await evaluationSchema());

    // `evidence` and `summary`. Both are genuine assertions rather than plain
    // absence - a rating of 0 has nothing to cite, and "I have nothing to add
    // beyond the per-criterion reasons" is a real answer - and two is nowhere
    // near the ceiling, so there is nothing to buy by changing them.
    expect(unions.length, unions.join(', ')).toBeLessThanOrEqual(UNION_PARAMETER_LIMIT);
    expect(unions).toEqual([
      '$.properties.ratings.items.properties.evidence',
      '$.properties.summary',
    ]);
  });

  it('sends an evaluation schema with no optional parameters at all', async () => {
    const optionals = optionalParameters(await evaluationSchema());

    // Every field of an evaluation is required, including the two nullable ones:
    // the model must decide about each rather than let one fall off the end of a
    // generation. It is the reason this schema was never near either cap, and
    // asserting zero is what stops a future field arriving as `.optional()`
    // because the extraction schema does it that way.
    expect(optionals.length, optionals.join(', ')).toBeLessThanOrEqual(OPTIONAL_PARAMETER_LIMIT);
    expect(optionals).toEqual([]);
  });

  it('stays under both limits whatever the role looks like', async () => {
    // The evaluation schema is built per role, so its size is data-dependent in
    // a way the extraction schema is not. Neither count may move with the number
    // of criteria: criteria add array items, not parameters.
    const wide = {
      ...GOLDEN_ROLE,
      criteria: Array.from({ length: 20 }, (_unused, index) => ({
        id: `c-${index}`,
        label: `Criterion ${index}`,
        description: 'x'.repeat(200),
        weight: index === 0 ? 81 : 1,
        position: index,
      })),
    };

    const schema = await evaluationSchema(wide);
    const unions = unionParameters(schema);
    const optionals = optionalParameters(schema);

    expect(unions.length, unions.join(', ')).toBeLessThanOrEqual(UNION_PARAMETER_LIMIT);
    expect(unions).toHaveLength(2);
    expect(optionals.length, optionals.join(', ')).toBeLessThanOrEqual(OPTIONAL_PARAMETER_LIMIT);
    expect(optionals).toEqual([]);
  });
});
