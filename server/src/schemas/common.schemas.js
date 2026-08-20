/**
 * Pieces every boundary schema reuses.
 *
 * Kept here rather than repeated so that "what is a page size" has one answer.
 * Anything specific to one resource lives with that resource.
 */

import { z } from 'zod';

/** The default page size, and the ceiling a client may ask for. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * A route parameter that must be a UUID.
 *
 * Validated rather than passed through, because an unvalidated value reaches
 * Postgres as `$1::uuid` and comes back as a driver error - a 500 for what is
 * plainly a client mistake, with a message nobody outside this repository should
 * see.
 */
export const uuidParam = z.string().uuid();

/**
 * Page number and size, as they arrive on a query string.
 *
 * `coerce` because every query parameter is a string; the bounds are what stop
 * `?pageSize=100000` from becoming a full table scan.
 */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/**
 * Turns a validated page/size pair into what a repository takes.
 *
 * @param {{ page: number, pageSize: number }} input
 * @returns {{ limit: number, offset: number }}
 */
export function toLimitOffset({ page, pageSize }) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * The pagination half of the `meta` object.
 *
 * `totalPages` is at least 1 even when there is nothing to show, so a client
 * rendering "page 1 of 0" never happens.
 *
 * @param {{ page: number, pageSize: number, total: number }} input
 * @returns {{ page: number, pageSize: number, total: number, totalPages: number }}
 */
export function paginationMeta({ page, pageSize, total }) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
