/**
 * The four-step stepper: Upload → Parse → Evaluate → Done.
 *
 * ## No fake percentage
 *
 * The server pipeline has no progress to report. Screening one CV is text
 * extraction plus two LLM calls, and the second one takes anywhere from four
 * seconds to forty. A bar creeping to 90% on a timer either stalls - which reads
 * as broken - or lies. The stepper says *which stage*, which is the thing a
 * recruiter actually wants to know, and the elapsed time beside it says how long
 * it has been there.
 *
 * ## The mapping, and the one thing it will not guess
 *
 * `pending` is queued behind Upload, `parsing` is Parse, `evaluating` is
 * Evaluate, `done` is Done.
 *
 * `failed` is the interesting one: **the status column does not record which
 * stage it failed at.** So a failed candidate shows Upload complete - which it
 * demonstrably is, the bytes are on disk - the final step failed, and the two
 * middle steps left unclaimed rather than filled in from the error code. The
 * detail view has the recruiter-facing message, which says what actually went
 * wrong; a stepper inventing "it got through Parse" would be a guess in the
 * shape of a fact.
 */

import { formatElapsed } from '../../lib/format.js';

const STEPS = [
  { key: 'upload', label: 'Upload' },
  { key: 'parse', label: 'Parse' },
  { key: 'evaluate', label: 'Evaluate' },
  { key: 'done', label: 'Done' },
];

/** Which step index a status sits on. */
const STEP_INDEX_BY_STATUS = {
  pending: 0,
  parsing: 1,
  evaluating: 2,
  done: 3,
  failed: 3,
};

/**
 * @param {object} props
 * @param {string} props.status a candidate status
 * @param {number | null} [props.elapsedMs] time since this candidate was accepted
 */
export function PipelineStepper({ status, elapsedMs = null }) {
  const activeIndex = STEP_INDEX_BY_STATUS[status] ?? 0;
  const failed = status === 'failed';
  const complete = status === 'done';

  return (
    <>
      <ol className="stepper">
        {STEPS.map((step, index) => {
          const state = failed
            ? // Upload is the only step a failed candidate is known to have
              // completed. The rest are left unclaimed on purpose.
              index === 0
              ? 'done'
              : index === STEPS.length - 1
                ? 'failed'
                : 'todo'
            : complete || index < activeIndex
              ? 'done'
              : index === activeIndex
                ? 'active'
                : 'todo';

          return (
            <li key={step.key} className={`stepper__step stepper__step--${state}`}>
              <span className="stepper__dot" aria-hidden="true" />
              <span>{step.label}</span>
              <span className="visually-hidden">
                {state === 'done'
                  ? ' complete'
                  : state === 'active'
                    ? ' in progress'
                    : state === 'failed'
                      ? ' failed'
                      : ' not started'}
              </span>
            </li>
          );
        })}
      </ol>
      {elapsedMs !== null && !complete && !failed ? (
        <p className="muted">Working for {formatElapsed(elapsedMs)}.</p>
      ) : null}
    </>
  );
}
