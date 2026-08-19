/**
 * The logger the deterministic core expects to be handed.
 *
 * Dependency injection is the boundary discipline for the whole agent layer, and
 * that applies to logging as much as to the clock and the client: a pure function
 * that reaches for a module-level logger is no longer testable without one.
 *
 * The interface is deliberately one method. Nothing in phase 2a has anything to
 * say that is not a warning about input it decided to drop.
 *
 * @typedef {object} AgentLogger
 * @property {(message: string, context?: Record<string, unknown>) => void} warn
 */

/**
 * The default. Swallowing a warning is the correct behaviour for a caller that
 * did not ask for one - and it keeps every scoring function callable with two
 * arguments in a test.
 *
 * @type {AgentLogger}
 */
export const NOOP_LOGGER = Object.freeze({
  warn() {},
});
