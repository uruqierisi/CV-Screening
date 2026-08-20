import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ok, parseOrThrow } from '../../src/http/boundary.js';
import { isAppError } from '../../src/errors/AppError.js';

/**
 * The two ends of the boundary: nothing unparsed goes in, nothing unshaped comes
 * out.
 *
 * Small enough that the whole of it is here, and worth pinning because every
 * controller in the system routes its params, its query and its body through
 * `parseOrThrow` - a change to what it throws changes every 400 in the API.
 */

describe('parseOrThrow', () => {
  it('returns the parsed value, not the input', () => {
    const schema = z.object({ page: z.coerce.number().int() });
    // Parsed data crosses inward; raw data never does. The coercion is the
    // observable difference.
    expect(parseOrThrow(schema, { page: '3' })).toEqual({ page: 3 });
  });

  it('throws a VALIDATION_FAILED AppError naming the bad fields', () => {
    const schema = z.object({ title: z.string().min(1) });

    try {
      parseOrThrow(schema, { title: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.status).toBe(400);
      expect(error.details.fields[0].path).toBe('title');
    }
  });

  it('uses the caller message when one is given, and a default otherwise', () => {
    const schema = z.string();

    expect(() => parseOrThrow(schema, 1, 'The query string is wrong.')).toThrow(
      'The query string is wrong.',
    );
    expect(() => parseOrThrow(schema, 1)).toThrow(/did not match the expected shape/);
  });
});

describe('ok', () => {
  it('omits `meta` when there is none, so a client can branch on its presence', () => {
    expect(ok({ id: 'c1' })).toEqual({ data: { id: 'c1' } });
    expect('meta' in ok({ id: 'c1' })).toBe(false);
  });

  it('includes `meta` when there is some', () => {
    expect(ok([], { page: 1 })).toEqual({ data: [], meta: { page: 1 } });
  });
});
