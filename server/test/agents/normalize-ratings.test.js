import { describe, expect, it } from 'vitest';
import {
  cleanEvidence,
  cleanReason,
  normalizeEvaluation,
} from '../../src/agents/evaluation/normalize-ratings.js';

/**
 * The bug this exists for, first, and then the cases that must NOT be touched.
 *
 * The prompt hands the model the profile as pretty-printed JSON and asks it to
 * quote from it, so a faithful copy can run off the end of a string value and
 * take the syntax with it. The response is valid JSON and passes the schema, so
 * this is the only place it can be caught.
 *
 * Half of these tests are about restraint. A cleaner that ate a legitimate
 * closing quote would corrupt evidence on the screen a reviewer reads hardest,
 * which is a worse bug than the one it fixes.
 */

describe('cleanEvidence: the artifact', () => {
  it('removes the JSON tail a copied quote drags along', () => {
    expect(cleanEvidence('Led the payments platform team of six engineers"},')).toBe(
      'Led the payments platform team of six engineers',
    );
  });

  it('removes a closing brace with no comma', () => {
    expect(cleanEvidence('Designed an event-driven ledger"}')).toBe(
      'Designed an event-driven ledger',
    );
  });

  it('removes a bracket from the end of an array element', () => {
    expect(cleanEvidence('PostgreSQL"]')).toBe('PostgreSQL');
  });

  it('removes a dangling comma from a span cut mid-list', () => {
    expect(cleanEvidence('JavaScript, TypeScript, Node.js,')).toBe(
      'JavaScript, TypeScript, Node.js',
    );
  });

  it('removes the unbalanced quote left when structure is stripped', () => {
    expect(cleanEvidence('Owned the migration from a monolith"')).toBe(
      'Owned the migration from a monolith',
    );
  });

  it('removes structure exposed by removing the quote, in either order', () => {
    expect(cleanEvidence('  Built ingestion pipelines"  }  ,  ')).toBe(
      'Built ingestion pipelines',
    );
  });

  it('removes the leading structure of a copy that began too early', () => {
    expect(cleanEvidence('{ "summary": Ten years of Node.js')).toBe('"summary": Ten years of Node.js');
  });

  it('unwraps a quote the model wrapped in quotes', () => {
    expect(cleanEvidence('"Led the payments platform"')).toBe('Led the payments platform');
  });
});

describe('cleanEvidence: what it must leave alone', () => {
  it('leaves ordinary prose untouched', () => {
    const text = 'Ten years of backend work, most recently on payments at scale.';
    expect(cleanEvidence(text)).toBe(text);
  });

  it('keeps a closing quote that closes something', () => {
    const text = 'The CV says "led the platform team" in two places';
    expect(cleanEvidence(text)).toBe(text);
  });

  it('keeps a balanced closing quote even behind a dangling comma', () => {
    // Pass 1 removes the comma; pass 2 must then see an even quote count and
    // leave the closing quote alone.
    expect(cleanEvidence('he said "hi",')).toBe('he said "hi"');
  });

  it('does not unwrap when the quotes are two separate quotations', () => {
    const text = '"hello" to the team and later "goodbye"';
    expect(cleanEvidence(text)).toBe(text);
  });

  it('keeps prose that ends in punctuation of its own', () => {
    const text = 'Scaled the ledger (40 million rows).';
    expect(cleanEvidence(text)).toBe(text);
  });
});

describe('cleanEvidence: absence', () => {
  it('passes null through, which is what a rating of 0 carries', () => {
    expect(cleanEvidence(null)).toBeNull();
  });

  it('treats undefined as absent', () => {
    expect(cleanEvidence(undefined)).toBeNull();
  });

  it('turns a value that was only punctuation into null, not an empty quote', () => {
    // The matrix has a branch that says the model cited no evidence. That is
    // more useful than an empty blockquote, which reads as a rendering fault.
    expect(cleanEvidence('"},')).toBeNull();
    expect(cleanEvidence('   ')).toBeNull();
  });
});

describe('normalizeEvaluation', () => {
  const evaluation = Object.freeze({
    ratings: [
      { criterionId: 'a', rating: 8, reason: 'Strong', evidence: 'Led the platform"},' },
      { criterionId: 'b', rating: 0, reason: 'Silent', evidence: null },
    ],
    summary: 'A solid backend candidate.',
  });

  it('cleans every rating and leaves the rest of the response alone', () => {
    const result = normalizeEvaluation(evaluation);

    expect(result.ratings[0].evidence).toBe('Led the platform');
    expect(result.ratings[1].evidence).toBeNull();
    expect(result.summary).toBe('A solid backend candidate.');
    expect(result.ratings.map((r) => r.criterionId)).toEqual(['a', 'b']);
  });

  it('does not mutate the response the retry logic and usage accounting refer to', () => {
    normalizeEvaluation(evaluation);

    expect(evaluation.ratings[0].evidence).toBe('Led the platform"},');
  });

  it('cleans reason as well, which renders in the same table cell', () => {
    const result = normalizeEvaluation({
      ratings: [
        { criterionId: 'a', rating: 7, reason: 'Ran the migration"},', evidence: null },
      ],
      summary: null,
    });

    expect(result.ratings[0].reason).toBe('Ran the migration');
  });
});

describe('cleanReason', () => {
  it('strips the same artifact evidence gets', () => {
    expect(cleanReason('Owned the ledger rewrite"},')).toBe('Owned the ledger rewrite');
  });

  it('leaves ordinary prose alone', () => {
    const text = 'Eight years on payments, most recently as a staff engineer.';
    expect(cleanReason(text)).toBe(text);
  });

  it('keeps what the model wrote when cleaning would empty it', () => {
    // The schema requires a non-empty reason and there is no honest empty value
    // to substitute. A trailing brace beats a blank justification column.
    expect(cleanReason('"},')).toBe('"},');
  });

  it('passes a non-string through for the schema to reject', () => {
    expect(cleanReason(null)).toBeNull();
  });
});
