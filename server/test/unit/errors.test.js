import { describe, expect, it } from 'vitest';
import { AppError, isAppError, validationError } from '../../src/errors/AppError.js';
import {
  ERROR_CODES,
  ERROR_STATUS_BY_CODE,
  ROUTE_NOT_FOUND_CODE,
  statusForCode,
} from '../../src/errors/codes.js';
import {
  FRAMEWORK_ERROR_TRANSLATIONS,
  errorHandler,
  notFoundHandler,
  toAppError,
} from '../../src/http/errorHandler.js';
import { z } from 'zod';

/**
 * The error layer, tested as data rather than as behaviour where it is data.
 *
 * The point of `ERROR_STATUS_BY_CODE` being a frozen object is that plan section
 * 3's table can be checked against it row by row. If somebody invents a status
 * at a throw site, or adds a code without deciding what it means over HTTP, that
 * is a failing test rather than a 500 in production.
 */

describe('the code-to-status table', () => {
  // Transcribed from plan section 3, deliberately by hand. Deriving it from the
  // source would assert only that the source equals itself.
  const PLAN_TABLE = {
    VALIDATION_FAILED: 400,
    EMPTY_UPLOAD: 400,
    ROLE_NOT_FOUND: 404,
    CANDIDATE_NOT_FOUND: 404,
    JOB_NOT_FOUND: 404,
    ROLE_ARCHIVED: 409,
    ROLE_NOT_SCOREABLE: 409,
    CANDIDATE_NOT_RETRYABLE: 409,
    SOURCE_FILE_MISSING: 410,
    FILE_TOO_LARGE: 413,
    TOO_MANY_FILES: 413,
    UNSUPPORTED_FILE_TYPE: 415,
    WEIGHTS_MUST_SUM_TO_100: 422,
    DUPLICATE_CRITERION_LABEL: 422,
    RATE_LIMITED: 429,
    STORAGE_WRITE_FAILED: 500,
    INTERNAL_ERROR: 500,
    DEPENDENCY_UNAVAILABLE: 503,
  };

  it.each(Object.entries(PLAN_TABLE))('maps %s to %i', (code, status) => {
    expect(ERROR_STATUS_BY_CODE[code]).toBe(status);
  });

  it('carries nothing beyond the plan table except the unrouted-path code', () => {
    const extra = Object.keys(ERROR_STATUS_BY_CODE).filter((code) => !(code in PLAN_TABLE));
    expect(extra).toEqual([ROUTE_NOT_FOUND_CODE]);
  });

  it('derives ERROR_CODES from the table so the two cannot drift', () => {
    expect(Object.keys(ERROR_CODES)).toEqual(Object.keys(ERROR_STATUS_BY_CODE));
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('falls back to 500 for a code nobody registered', () => {
    expect(statusForCode('SOMETHING_NOBODY_DECIDED')).toBe(500);
  });

  it('is frozen, so a throw site cannot edit the mapping at runtime', () => {
    expect(Object.isFrozen(ERROR_STATUS_BY_CODE)).toBe(true);
  });

  it('never maps a worker-side candidate code, because those are returned inside a 200', () => {
    // Plan section 5.4: the two namespaces are deliberately separate. The one
    // that looks like it belongs to both - UNSUPPORTED_FILE_TYPE - belongs here
    // only, because a file we cannot read never becomes a candidate row.
    for (const code of ['EXTRACTION_FAILED', 'EMPTY_DOCUMENT', 'AGENT_TIMEOUT', 'AGENT_BAD_OUTPUT']) {
      expect(ERROR_STATUS_BY_CODE[code]).toBeUndefined();
    }
    expect(ERROR_STATUS_BY_CODE.UNSUPPORTED_FILE_TYPE).toBe(415);
  });
});

describe('AppError', () => {
  it('takes its status from its code rather than carrying one', () => {
    expect(new AppError('ROLE_ARCHIVED', 'gone').status).toBe(409);
    expect(new AppError('SOURCE_FILE_MISSING', 'gone').status).toBe(410);
  });

  it('omits `details` from the response body when there are none', () => {
    expect(new AppError('EMPTY_UPLOAD', 'nothing attached').toResponse()).toEqual({
      code: 'EMPTY_UPLOAD',
      message: 'nothing attached',
    });
  });

  it('includes `details` when given some', () => {
    const error = new AppError('UNSUPPORTED_FILE_TYPE', 'bad file', {
      details: { rejected: [{ filename: 'x.zip', reason: 'zip_not_ooxml' }] },
    });
    expect(error.toResponse().details).toEqual({
      rejected: [{ filename: 'x.zip', reason: 'zip_not_ooxml' }],
    });
  });

  it('recognises a structurally identical error from another module instance', () => {
    // Two copies of this module under different specifiers is a real hazard in a
    // repository with an API process, a worker process and a test runner. A
    // duplicated class identity would silently turn a 409 into a 500.
    const lookalike = { name: 'AppError', code: 'ROLE_NOT_FOUND', status: 404 };
    expect(isAppError(lookalike)).toBe(true);
    expect(isAppError(new Error('nope'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('validationError', () => {
  it('names every bad field with a dotted path', () => {
    const schema = z.object({
      title: z.string(),
      criteria: z.array(z.object({ weight: z.number() })),
    });
    const result = schema.safeParse({ title: 4, criteria: [{ weight: 'ten' }] });

    const error = validationError(/** @type {any} */ (result).error);

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(400);
    expect(error.details?.fields).toEqual([
      { path: 'title', message: expect.any(String) },
      { path: 'criteria.0.weight', message: expect.any(String) },
    ]);
  });
});

describe('toAppError', () => {
  it('passes an AppError through untouched', () => {
    const original = new AppError('JOB_NOT_FOUND', 'no such job');
    const { appError, unexpected } = toAppError(original);
    expect(appError).toBe(original);
    expect(unexpected).toBe(false);
  });

  it.each(Object.entries(FRAMEWORK_ERROR_TRANSLATIONS))(
    'translates the framework code %s into %o',
    (code, translation) => {
      const { appError, unexpected } = toAppError({ code });
      expect(appError.code).toBe(translation.code);
      expect(appError.message).toBe(translation.message);
      expect(unexpected).toBe(false);
    },
  );

  it('recognises the rate limiter by its status', () => {
    const { appError } = toAppError({ statusCode: 429, message: 'Rate limit exceeded' });
    expect(appError.code).toBe('RATE_LIMITED');
    expect(appError.status).toBe(429);
  });

  it('turns anything else into INTERNAL_ERROR and keeps its message out of the body', () => {
    const leaky = new Error('postgres://user:hunter2@db:5432/prod refused the connection');
    const { appError, unexpected } = toAppError(leaky);

    expect(unexpected).toBe(true);
    expect(appError.code).toBe('INTERNAL_ERROR');
    expect(appError.status).toBe(500);
    expect(JSON.stringify(appError.toResponse())).not.toContain('hunter2');
    expect(JSON.stringify(appError.toResponse())).not.toContain('postgres://');
  });

  it('does not mistake a 429 that is also an AppError for the rate limiter', () => {
    const original = new AppError('RATE_LIMITED', 'ours');
    expect(toAppError(original).appError).toBe(original);
  });
});


/**
 * A request and a reply small enough to assert against.
 *
 * The handler is a pure function of these three arguments, so it does not need a
 * server to be exercised - and the thing worth exercising is the LOGGING, which
 * an HTTP-level test cannot see.
 */
function stubs() {
  /** @type {{ level: string, context: any, message: string }[]} */
  const logged = [];
  const log = {
    error: (context, message) => logged.push({ level: 'error', context, message }),
    info: (context, message) => logged.push({ level: 'info', context, message }),
    warn: (context, message) => logged.push({ level: 'warn', context, message }),
  };

  /** @type {{ status: number | null, body: any }} */
  const sent = { status: null, body: null };
  const reply = {
    status(code) {
      sent.status = code;
      return reply;
    },
    send(body) {
      sent.body = body;
      return reply;
    },
  };

  return { request: { id: 'req-1', log }, reply, logged, sent };
}

describe('errorHandler', () => {
  it('answers an AppError with its own status, code and details', () => {
    const { request, reply, sent } = stubs();

    errorHandler(new AppError('ROLE_ARCHIVED', 'archived', { details: { roleId: 'r1' } }), request, reply);

    expect(sent.status).toBe(409);
    expect(sent.body).toEqual({
      error: {
        code: 'ROLE_ARCHIVED',
        message: 'archived',
        details: { roleId: 'r1' },
        requestId: 'req-1',
      },
    });
  });

  it('logs an expected client failure at info, not as a fault of ours', () => {
    const { request, reply, logged } = stubs();

    errorHandler(new AppError('CANDIDATE_NOT_FOUND', 'no such candidate'), request, reply);

    // A wall of 404s should be visible without drowning a real fault.
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe('info');
    expect(logged[0].context).toMatchObject({ code: 'CANDIDATE_NOT_FOUND', status: 404 });
  });

  it('logs a typed 5xx at error, with the original attached', () => {
    const { request, reply, logged, sent } = stubs();
    const cause = new Error('ENOSPC: no space left on device');

    errorHandler(
      new AppError('STORAGE_WRITE_FAILED', 'The upload could not be saved. Try again.', { cause }),
      request,
      reply,
    );

    expect(sent.status).toBe(500);
    expect(logged[0].level).toBe('error');
    // The errno is in the log; the client got our sentence and a request id.
    expect(JSON.stringify(sent.body)).not.toContain('ENOSPC');
  });

  it('logs an unexpected throw in full and answers with a request id only', () => {
    const { request, reply, logged, sent } = stubs();
    const leaky = new Error('postgres://cv:hunter2@db/prod');

    errorHandler(leaky, request, reply);

    expect(logged[0].level).toBe('error');
    expect(logged[0].context.err).toBe(leaky);
    expect(sent.status).toBe(500);
    expect(sent.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: expect.any(String),
      requestId: 'req-1',
    });
  });
});

describe('notFoundHandler', () => {
  it('answers an unrouted path in the same envelope', () => {
    const { request, reply, sent } = stubs();

    notFoundHandler(request, reply);

    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({
      error: { code: ROUTE_NOT_FOUND_CODE, message: 'No such endpoint.', requestId: 'req-1' },
    });
  });
});
