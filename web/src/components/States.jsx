/**
 * The error and empty states, written once so no screen has to invent them.
 *
 * ## Two rules, and they are the whole file
 *
 * **The server's message is shown verbatim.** Every error this API produces
 * carries a `message` that somebody wrote for a person to read - "criterion
 * weights must sum to 100, received 92", "This PDF appears to be a scanned
 * image". Replacing that with "Something went wrong" throws away the only useful
 * thing in the response.
 *
 * **The `requestId` is always rendered.** It is the only handle a user has when
 * they report a problem, and it is the only string that finds the log line. It
 * is shown even when the message is self-explanatory, because the moment it
 * matters is the moment nobody thought it would.
 */

/**
 * @param {object} props
 * @param {string} props.title what failed, in the caller's own words
 * @param {{ code?: string, message?: string, requestId?: string | null, status?: number } | null} props.error
 * @param {string} [props.hint] what the reader can do about it
 * @param {() => void} [props.onRetry]
 * @param {string} [props.retryLabel]
 */
export function ErrorState({ title, error, hint, onRetry, retryLabel = 'Try again' }) {
  return (
    <div className="state state--error" role="alert">
      <h2 className="state__title">{title}</h2>
      {error?.message ? <p className="state__detail">{error.message}</p> : null}
      {hint ? <p className="state__detail">{hint}</p> : null}
      <p className="state__meta">
        {error?.code ? <>Error code: {error.code}. </> : null}
        {error?.requestId ? (
          <>Request id: {error.requestId}</>
        ) : (
          <>No request id: the request did not reach the server.</>
        )}
      </p>
      {onRetry ? (
        <p style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
          <button type="button" className="button" onClick={onRetry}>
            {retryLabel}
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The empty state.
 *
 * `message` says what is absent and why that might be; `action` is the control
 * that fixes it. An empty state with no next action is a dead end, so `action`
 * is expected on every screen where one exists.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.message
 * @param {import('react').ReactNode} [props.action]
 */
export function EmptyState({ title, message, action }) {
  return (
    <div className="state">
      <h2 className="state__title">{title}</h2>
      <p className="state__detail">{message}</p>
      {action}
    </div>
  );
}
