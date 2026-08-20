/**
 * Roles: parse, delegate, serialize, choose a status. Nothing else.
 *
 * The one piece of judgement in this file is `withSpecificRoleCode`, and it is
 * here rather than in the service because it is a mapping from a validation
 * failure to an HTTP status, which is precisely this layer's job.
 */

import { AppError, validationError } from '../errors/AppError.js';
import { ok, parseOrThrow } from '../http/boundary.js';
import { toRoleDto } from '../http/dto/roleDto.js';
import {
  listRolesQuerySchema,
  roleBodySchema,
  specificRoleErrorCode,
} from '../schemas/role.schemas.js';
import { paginationMeta, toLimitOffset, uuidParam } from '../schemas/common.schemas.js';
import {
  archiveRoleById,
  createRole,
  getRole,
  listRolesPage,
  replaceRole,
} from '../services/rolesService.js';

/**
 * Parses a role body, promoting the two failures plan section 3 gives their own
 * 422 code to that code.
 *
 * Everything else in the body is an ordinary `VALIDATION_FAILED` 400. The
 * distinction is worth the code: "weights must sum to 100" and "you have two
 * criteria called Communication" are the two mistakes a recruiter actually makes
 * on this form, and a client that can branch on them can put the message next to
 * the right control instead of at the top of the page.
 *
 * @param {unknown} body
 * @returns {import('../schemas/role.schemas.js').RoleBody}
 */
function parseRoleBody(body) {
  const result = roleBodySchema.safeParse(body);
  if (result.success) return result.data;

  const specific = specificRoleErrorCode(result.error);
  if (specific !== null) {
    const generic = validationError(result.error);
    throw new AppError(specific, result.error.issues[0].message, {
      details: generic.details,
    });
  }

  throw validationError(result.error);
}

/**
 * `POST /api/v1/roles` -> 201
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function postRole(request, reply) {
  const body = parseRoleBody(request.body);
  const full = await createRole(body);
  return reply.status(201).send(ok(toRoleDto(full)));
}

/**
 * `GET /api/v1/roles` -> 200
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getRoles(request, reply) {
  const query = parseOrThrow(listRolesQuerySchema, request.query);
  const { roles, total } = await listRolesPage({
    ...toLimitOffset(query),
    includeArchived: query.includeArchived,
  });

  return reply.send(
    ok(roles.map(toRoleDto), paginationMeta({ page: query.page, pageSize: query.pageSize, total })),
  );
}

/**
 * `GET /api/v1/roles/:roleId` -> 200
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getRoleById(request, reply) {
  const roleId = parseOrThrow(uuidParam, /** @type {any} */ (request.params).roleId);
  return reply.send(ok(toRoleDto(await getRole(roleId))));
}

/**
 * `PUT /api/v1/roles/:roleId` -> 200
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function putRole(request, reply) {
  const roleId = parseOrThrow(uuidParam, /** @type {any} */ (request.params).roleId);
  const body = parseRoleBody(request.body);
  return reply.send(ok(toRoleDto(await replaceRole(roleId, body))));
}

/**
 * `DELETE /api/v1/roles/:roleId` -> 200
 *
 * 200 with the archived role rather than 204: archiving is idempotent and the
 * client wants the row back to update its list in place, which a 204 would make
 * it re-fetch.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function deleteRole(request, reply) {
  const roleId = parseOrThrow(uuidParam, /** @type {any} */ (request.params).roleId);
  return reply.send(ok(toRoleDto(await archiveRoleById(roleId))));
}
