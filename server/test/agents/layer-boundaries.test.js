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
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@anthropic-ai/sdk',
      'pg',
      'zod',
      'zod-to-json-schema',
    ]);
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
