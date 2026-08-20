import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as agents from '../../src/agents/index.js';

/**
 * The constraints that define this layer, asserted rather than remembered.
 *
 * Phase 2a was the deterministic core and could assert the simplest possible
 * rule: no SDK anywhere. Phase 2b brought one in, so the rule becomes the one
 * the plan actually states - **exactly one file imports it, and that file only
 * constructs** - and it is worth more now than the blanket ban was, because it
 * is what keeps every other module testable with an injected fake and keeps the
 * suite network-free without module mocking.
 *
 * A comment saying "do not import the SDK here" is a wish. This is the check.
 */

const AGENTS_DIR = fileURLToPath(new URL('../../src/agents', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

/** The one file allowed to know an SDK exists. */
const SDK_BOUNDARY_FILE = 'client/anthropic-client.js';

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

const AGENT_FILES = listJsFiles(AGENTS_DIR);

/** @param {string} file @returns {string} path relative to src/agents, with / separators */
function relative(file) {
  return file.slice(AGENTS_DIR.length + 1).replace(/\\/g, '/');
}

/**
 * Every module specifier that is imported for its runtime value. JSDoc
 * `import('...')` type references are excluded on purpose: they are erased,
 * they cost nothing at runtime, and forbidding them would mean the layer could
 * not describe the shape of the data it is handed.
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

describe('the agent layer imports nothing it should not', () => {
  it('finds the files it is supposed to be checking', () => {
    // Guards the walker: an empty list would make every assertion below vacuous.
    expect(AGENT_FILES.length).toBeGreaterThanOrEqual(20);
    expect(AGENT_FILES.some((file) => file.endsWith('score-candidate.js'))).toBe(true);
    expect(AGENT_FILES.some((file) => file.endsWith('screen-candidate.js'))).toBe(true);
  });

  it('imports three third-party packages, and each has a reason', () => {
    const external = new Set();

    for (const file of AGENT_FILES) {
      for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) {
          external.add(specifier);
        }
      }
    }

    // zod: every schema. @anthropic-ai/sdk: the client and its JSON-Schema
    // transform, both confined to one file. zod-to-json-schema: derives the
    // model-facing JSON Schema from the zod schema we already validate with, so
    // there is one definition of the shape rather than two that agree until
    // somebody edits one.
    expect([...external].sort()).toEqual([
      '@anthropic-ai/sdk',
      '@anthropic-ai/sdk/helpers/json-schema',
      'zod',
      'zod-to-json-schema',
    ]);
  });

  it('confines the SDK to exactly one file', () => {
    const importers = AGENT_FILES.filter((file) =>
      runtimeImports(readFileSync(file, 'utf8')).some((specifier) =>
        specifier.startsWith('@anthropic-ai/sdk'),
      ),
    ).map(relative);

    expect(importers).toEqual([SDK_BOUNDARY_FILE]);
  });

  it('never constructs a client outside that file', () => {
    // Everything else takes `{ client, now, logger }`. This is the property the
    // whole test strategy rests on: a `new Anthropic(...)` anywhere else is a
    // test that could reach the network.
    for (const file of AGENT_FILES) {
      if (relative(file) === SDK_BOUNDARY_FILE) continue;
      const source = readFileSync(file, 'utf8');
      expect(source, relative(file)).not.toMatch(/new\s+Anthropic\s*\(/);
    }
  });

  it('reaches for no network client, no database and no web framework', () => {
    const forbidden = [
      'openai',
      'pg',
      'fastify',
      'express',
      'bullmq',
      'ioredis',
      'axios',
      'undici',
      'node-fetch',
      'node:http',
      'node:https',
      'node:net',
      'node:fs',
      'node:fs/promises',
    ];

    for (const file of AGENT_FILES) {
      const imports = runtimeImports(readFileSync(file, 'utf8'));
      for (const specifier of imports) {
        expect(forbidden, `${file} imports ${specifier}`).not.toContain(specifier);
      }
    }
  });

  it('calls no global fetch, and reads no clock or environment of its own', () => {
    for (const file of AGENT_FILES) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      expect(source, `${file}`).not.toMatch(/\bfetch\s*\(/);
      // `now` is injected everywhere. Reading the clock directly would make a
      // candidate's experience - and therefore their elimination - depend on when
      // the worker happened to run.
      expect(source, `${file}`).not.toMatch(/Date\.now\s*\(/);
      expect(source, `${file}`).not.toMatch(/new Date\s*\(\s*\)/);
      // The API key comes in as an argument. A layer that read `process.env`
      // could not be tested without one, and would eventually log one.
      expect(source, `${file}`).not.toMatch(/process\.env/);
    }
  });

  it('declares its dependencies, and nothing it does not use', () => {
    // A whole-repository check that lives here because this is where the
    // dependency discipline is written down. It is supposed to fail when a
    // package is added - that is the point - and each entry has to be worth a
    // line of justification.
    //
    // `unpdf` was added in phase 3 and is not the agent layer's: it is the PDF
    // text extractor, confined to `src/extraction/parsers/pdf.js`, and
    // `test/extraction/boundaries.test.js` asserts that confinement. It is
    // named here rather than exempted because a manifest check that ignores
    // half the manifest checks nothing.
    //
    // Phase 4 added six, every one of them named in the plan of record's stack
    // (section 0) or forced by one that is, and none of them reachable from
    // `src/agents/**` - the import check above is what enforces that:
    //
    //   fastify              the HTTP framework the plan chose
    //   @fastify/multipart   uploads; the alternative is hand-parsing multipart
    //   @fastify/rate-limit  section 3 names it, on the two upload endpoints
    //   bullmq               the queue the plan chose (section 7-G)
    //   ioredis              bullmq's Redis client - an optional peer dependency
    //                        it does not install, so it has to be declared here
    //   pino                 fastify's own logger, imported directly by the
    //                        worker, which has no fastify instance to borrow one
    //                        from
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@anthropic-ai/sdk',
      '@fastify/multipart',
      '@fastify/rate-limit',
      'bullmq',
      'fastify',
      'ioredis',
      'pg',
      'pino',
      'unpdf',
      'zod',
      'zod-to-json-schema',
    ]);
  });

  it('keeps every phase 4 dependency out of the two framework-agnostic layers', () => {
    // The rule the plan states in section 0 and section 5: `src/agents/` imports
    // no web framework and no DB driver, and `src/extraction/` is the same shape.
    // Six packages arrived in phase 4 and not one of them may cross either line -
    // the worker composes these layers, it does not let them learn about a queue.
    const phase4 = [
      'fastify',
      '@fastify/multipart',
      '@fastify/rate-limit',
      'bullmq',
      'ioredis',
      'pino',
    ];

    for (const file of AGENT_FILES) {
      const imports = runtimeImports(readFileSync(file, 'utf8'));
      for (const specifier of imports) {
        expect(phase4, `${file} imports ${specifier}`).not.toContain(specifier);
      }
    }
  });

  it('keeps prompt text out of the modules that have behavioural tests', () => {
    // One prompt, one file. The wording has to be iterable without touching code
    // whose tests are about control flow - so nothing outside `prompts/` is
    // allowed to hold a paragraph destined for a model.
    const promptWords = /\byou (?:are|must|will|rate|extract|transcribe)\b/i;

    for (const file of AGENT_FILES) {
      const path = relative(file);
      if (path.startsWith('prompts/')) continue;

      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      expect(code, path).not.toMatch(promptWords);
    }
  });
});

describe('the public surface', () => {
  it('exports the deterministic core through one path', () => {
    for (const name of [
      'scoreCandidate',
      'computeWeightedScore',
      'reconcileRatings',
      'evaluateEliminationRules',
      'assignTier',
      'parseRole',
      'makeEvaluationSchema',
      'extractedProfileSchema',
      'profileSchema',
      'verifiedProfileSchema',
      'computeExperience',
      'verifyEvidence',
    ]) {
      expect(agents[name], name).toBeDefined();
    }
  });

  it('exports the model-facing layer through the same path', () => {
    for (const name of [
      'screenCandidate',
      'extractProfile',
      'evaluateCandidate',
      'redactIdentity',
      'normalizeProfile',
      'callStructured',
      'createAnthropicClient',
      // The two ways of asking for JSON, and the parser that reads the answer
      // when no schema was sent. Public for the same reason `EXTRACTION_EFFORT`
      // is: it is a decision about a call, and a caller reasoning about cost or
      // reliability needs to be able to read it.
      'RESPONSE_FORMATS',
      'EXTRACTION_RESPONSE_FORMAT',
      'parseMessageJson',
      'stripCodeFences',
      'AgentSchemaRejectedError',
      'extractionPrompt',
      'evaluationPrompt',
      'assessCvText',
    ]) {
      expect(agents[name], name).toBeDefined();
    }
  });

  it('exports no function that produces a score other than the scoring ones', () => {
    // A second way to compute a score is a second answer waiting to disagree with
    // the first, which is why the plan cut the comparator the agent layer
    // originally proposed.
    const exported = Object.keys(agents).filter((name) => typeof agents[name] === 'function');
    expect(exported).not.toContain('compareCandidates');
    expect(exported).not.toContain('rankCandidates');
  });

  it('names the model exactly once, with no date suffix', () => {
    expect(agents.MODEL_ID).toBe('claude-opus-5');

    const mentions = AGENT_FILES.filter((file) =>
      /['"]claude-[a-z0-9-]+['"]/.test(readFileSync(file, 'utf8')),
    ).map(relative);

    expect(mentions).toEqual([SDK_BOUNDARY_FILE]);
  });
});
