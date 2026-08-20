import { describe, expect, it } from 'vitest';
import {
  SOURCE_FILE_MISSING_CODE,
  WORKER_CANDIDATE_ERROR_CODES,
  toCandidateFailure,
} from '../../src/queue/candidateFailure.js';
import { AgentTimeoutError, AgentRefusalError } from '../../src/agents/index.js';
import { EmptyDocumentError, ExtractionFailedError, UnsupportedFileTypeError } from '../../src/extraction/index.js';
import { IncompleteEvaluationError } from '../../src/agents/index.js';
import { ERROR_STATUS_BY_CODE } from '../../src/errors/codes.js';

/**
 * A thrown thing, turned into a stored candidate error.
 *
 * The two properties this file exists to hold:
 *
 * 1. **The namespaces stay apart.** Nothing the worker stores may be an API code
 *    that plan section 3's table also owns - with the one deliberate exception,
 *    `SOURCE_FILE_MISSING`, which means the same thing in both places.
 * 2. **No unknown message escapes.** A `TypeError` from a bug of ours gets the
 *    generic message, because `error.message` is exactly where a fragment of a
 *    CV or a connection string reaches a column the dashboard renders.
 */

describe('the worker-side code list', () => {
  it('is plan section 5.4 verbatim', () => {
    expect([...WORKER_CANDIDATE_ERROR_CODES].sort()).toEqual(
      [
        'EXTRACTION_FAILED',
        'EMPTY_DOCUMENT',
        'AGENT_TIMEOUT',
        'AGENT_RATE_LIMIT',
        'AGENT_UPSTREAM',
        'AGENT_REFUSED',
        'AGENT_BAD_OUTPUT',
        'AGENT_INCOMPLETE_EVAL',
        'AGENT_INPUT_TOO_LARGE',
        'AGENT_SCHEMA_REJECTED',
        'AGENT_INVALID_ROLE',
        'AGENT_UNKNOWN_RULE',
        'SOURCE_FILE_MISSING',
      ].sort(),
    );
  });

  it('does not include UNSUPPORTED_FILE_TYPE, which is an HTTP 415', () => {
    // Plan section 5.4, stated as a rule rather than rediscovered: a file whose
    // bytes we cannot read never becomes a candidate row, so there is no
    // `candidates.error_code` to store it in.
    expect(WORKER_CANDIDATE_ERROR_CODES).not.toContain('UNSUPPORTED_FILE_TYPE');
  });

  it('overlaps the API namespace on exactly one code, deliberately', () => {
    const overlap = WORKER_CANDIDATE_ERROR_CODES.filter((code) => code in ERROR_STATUS_BY_CODE);
    expect(overlap).toEqual([SOURCE_FILE_MISSING_CODE]);
  });
});

describe('toCandidateFailure', () => {
  it('stores an extraction failure with its recruiter-facing message', () => {
    const failure = toCandidateFailure(
      new ExtractionFailedError({
        reason: 'pdf_parse_error',
        message: 'pdf.js threw',
        userMessage: 'This PDF could not be read. Re-upload it.',
        details: {},
      }),
    );

    expect(failure).toEqual({
      errorCode: 'EXTRACTION_FAILED',
      errorMessage: 'This PDF could not be read. Re-upload it.',
      retryable: false,
    });
  });

  it('stores a scanned PDF as EMPTY_DOCUMENT', () => {
    const failure = toCandidateFailure(
      new EmptyDocumentError({
        userMessage: 'This PDF appears to be a scanned image.',
        details: {},
      }),
    );
    expect(failure.errorCode).toBe('EMPTY_DOCUMENT');
  });

  it('rewrites UNSUPPORTED_FILE_TYPE to EXTRACTION_FAILED rather than inventing a code', () => {
    // It can only reach the worker if the bytes on disk are not what the upload
    // allowlist accepted, which is a phase 4 bug and not a bad CV. Storing the
    // API's own 415 code in a column nothing maps to a status would confuse the
    // two namespaces the whole design keeps apart.
    const failure = toCandidateFailure(
      new UnsupportedFileTypeError({
        reason: 'zip_not_ooxml',
        userMessage: 'This file is not a PDF, a Word document or a plain text file.',
        details: {},
      }),
    );

    expect(failure.errorCode).toBe('EXTRACTION_FAILED');
    expect(failure.retryable).toBe(false);
  });

  it('carries the agent layer retryable label through, rather than re-deriving it', () => {
    // "The agent layer labels retryability; the worker decides retry policy."
    expect(toCandidateFailure(new AgentTimeoutError({ stage: 'extraction', deadlineMs: 240_000 }))).
      toMatchObject({ errorCode: 'AGENT_TIMEOUT', retryable: true });

    expect(
      toCandidateFailure(new AgentRefusalError({ stage: 'evaluation', stopDetails: { category: 'x' } })),
    ).toMatchObject({ errorCode: 'AGENT_REFUSED', retryable: false });
  });

  it('treats an incomplete evaluation as retryable, matching its own label', () => {
    expect(
      toCandidateFailure(new IncompleteEvaluationError(['c2'])),
    ).toMatchObject({ errorCode: 'AGENT_INCOMPLETE_EVAL', retryable: true });
  });

  it('stores a missing source file without retrying it', () => {
    const failure = toCandidateFailure({
      code: SOURCE_FILE_MISSING_CODE,
      userMessage: 'The uploaded file is no longer on the server.',
      retryable: false,
    });
    expect(failure.errorCode).toBe(SOURCE_FILE_MISSING_CODE);
    expect(failure.retryable).toBe(false);
  });

  it('never lets an unknown error message reach the stored message', () => {
    const leaky = new TypeError(
      'Cannot read properties of undefined - context: "Jane Doe, 07700 900123, jane@example.com"',
    );
    const failure = toCandidateFailure(leaky);

    expect(failure.errorCode).toBe('EXTRACTION_FAILED');
    expect(failure.errorMessage).not.toContain('Jane Doe');
    expect(failure.errorMessage).not.toContain('jane@example.com');
    // Unknown means unknown; the attempt count is what bounds the retrying.
    expect(failure.retryable).toBe(true);
  });

  it('does not trust a code that is not in the worker namespace', () => {
    // An error carrying `code: 'ROLE_ARCHIVED'` must not be able to write an API
    // code into candidates.error_code.
    const failure = toCandidateFailure({ code: 'ROLE_ARCHIVED', userMessage: 'nope' });
    expect(failure.errorCode).toBe('EXTRACTION_FAILED');
    expect(failure.errorMessage).not.toBe('nope');
  });

  it('falls back to a generic message when a known error carries none', () => {
    const failure = toCandidateFailure({ code: 'AGENT_UPSTREAM', retryable: true });
    expect(failure.errorCode).toBe('AGENT_UPSTREAM');
    expect(failure.errorMessage).toContain('Retry the candidate');
  });

  it('falls back to the generic message when an unsupported-type error carries none', () => {
    const failure = toCandidateFailure({ code: 'UNSUPPORTED_FILE_TYPE' });
    expect(failure.errorCode).toBe('EXTRACTION_FAILED');
    expect(failure.errorMessage).toContain('Retry the candidate');
    expect(failure.retryable).toBe(false);
  });

  it('handles a thrown non-object without crashing', () => {
    expect(toCandidateFailure('boom').errorCode).toBe('EXTRACTION_FAILED');
    expect(toCandidateFailure(undefined).errorCode).toBe('EXTRACTION_FAILED');
  });
});
