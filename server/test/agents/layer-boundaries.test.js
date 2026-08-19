import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as agents from '../../src/agents/index.js';

/**
 * The constraints that define this phase, asserted rather than remembered.
 *
 * Phase 2a is the deterministic core: no LLM, no network, no SDK. Phase 5 of the
 * plan's settled decisions also says the agent layer imports no web framework and
 * no database driver, and that holds for 2b as well - only `client/` will ever
 * import the Anthropic SDK, and it does not exist yet.
 *
 * A comment saying "do not import pg here" is a wish. This is the check.
 */

const AGENTS_DIR = fileURLToPath(new URL('../../src/agents', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

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
    expect(AGENT_FILES.length).toBeGreaterThanOrEqual(10);
    expect(AGENT_FILES.some((file) => file.endsWith('score-candidate.js'))).toBe(true);
  });

  it('imports exactly one third-party package, and it is zod', () => {
    const external = new Set();

    for (const file of AGENT_FILES) {
      for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) {
          external.add(specifier);
        }
      }
    }

    expect([...external]).toEqual(['zod']);
  });

  it('reaches for no SDK, no network client, no database and no web framework', () => {
    const forbidden = [
      '@anthropic-ai/sdk',
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
      expect(source, `${file}`).not.toMatch(/process\.env/);
    }
  });

  it('has not quietly acquired the Anthropic SDK as a dependency', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(Object.keys(declared)).not.toContain('@anthropic-ai/sdk');
    expect(Object.keys(pkg.dependencies)).toEqual(['pg', 'zod']);
  });

  it('does not yet contain the phase 2b modules', () => {
    // 2b is built on a 2a that is already proven. Stubs here would mean a failure
    // in 2b could hide as a scoring bug, which is the whole reason for the split.
    const paths = AGENT_FILES.map((file) => file.replace(/\\/g, '/'));

    for (const notYet of ['/client/', '/prompts/', '/evaluation/', '/pipeline/']) {
      expect(paths.some((file) => file.includes(notYet)), notYet).toBe(false);
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

  it('exports no function that produces a score other than the scoring ones', () => {
    // A second way to compute a score is a second answer waiting to disagree with
    // the first, which is why the plan cut the comparator the agent layer
    // originally proposed.
    const exported = Object.keys(agents).filter((name) => typeof agents[name] === 'function');
    expect(exported).not.toContain('compareCandidates');
    expect(exported).not.toContain('rankCandidates');
  });
});
