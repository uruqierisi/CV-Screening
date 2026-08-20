/**
 * Logging seams.
 *
 * Two small things, both of which exist because a log line is a boundary like
 * any other: something crosses it and cannot be taken back.
 */

/** @typedef {import('../agents/util/logger.js').AgentLogger} AgentLogger */

/**
 * Fields whose value must never appear in a log line, wherever they turn up.
 *
 * Redaction is configured **at the logging boundary**, once, rather than by
 * remembering to omit a field at each call site - because the call site that
 * forgets is the one nobody reviewed. Pino applies these paths to every object
 * it serializes.
 *
 * `x-api-key` and `authorization` are the two headers that carry a credential
 * into this process; `apiKey` catches an options object serialized whole, which
 * is how an SDK configuration usually escapes.
 *
 * @type {readonly string[]}
 */
export const REDACTED_LOG_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-api-key"]',
  'apiKey',
  '*.apiKey',
  'ANTHROPIC_API_KEY',
  '*.ANTHROPIC_API_KEY',
]);

/**
 * Adapts a pino-style logger to the one-method interface the agent layer takes.
 *
 * The two signatures are genuinely different and the difference is not
 * cosmetic: the agent layer calls `warn(message, context)` - message first,
 * because a pure function warning about input it dropped has a sentence to say
 * and some ids to attach - while pino is `warn(mergingObject, message)`. Passing
 * a pino logger straight in would produce log lines with the context in the
 * format-arguments position, which is silently wrong rather than loudly wrong.
 *
 * So the adapter is one function, here, and the agent layer keeps its own
 * interface rather than being bent to a library it must not import.
 *
 * @param {{ warn: Function }} [logger] pino, or anything with a `warn`
 * @returns {AgentLogger}
 */
export function toAgentLogger(logger) {
  if (logger === undefined || typeof logger.warn !== 'function') {
    return { warn() {} };
  }
  return {
    warn(message, context) {
      logger.warn(context ?? {}, message);
    },
  };
}
