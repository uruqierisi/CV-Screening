/**
 * `/config`, fetched once at app start and made available to the whole tree.
 *
 * ## Why this is a gate rather than a background load
 *
 * Every screen below it needs something from this payload before it can render
 * honestly: the upload screen needs `maxFileBytes` and `acceptedMimeTypes` to
 * validate a file, the role form needs `eliminationRules.descriptors` to render
 * a rule's fields at all, and the dashboard needs `fitCategories` to build its
 * tier filter. The alternative - render now, correct later - means a form that
 * accepts a 12 MB PDF for half a second and then does not.
 *
 * So the app shows one loading state, once, and then everything below can treat
 * the config as present. `useConfig()` throws outside the provider rather than
 * returning a default, because a default here is a duplicated constant wearing a
 * disguise, and that is the exact thing plan section 3 built this endpoint to
 * prevent.
 */

import { createContext, useCallback, useContext } from 'react';
import { getConfig } from '../api/meta.js';
import { useResource } from '../hooks/useResource.js';
import { useSlowRequest } from '../hooks/useSlowRequest.js';
import { ErrorState } from '../components/States.jsx';
import { Spinner } from '../components/Spinner.jsx';

const ConfigContext = createContext(null);

/**
 * @returns {{
 *   upload: { maxFileBytes: number, maxBatchFiles: number, acceptedMimeTypes: string[] },
 *   scoring: {
 *     requiredWeightSum: number, weightMin: number, weightMax: number,
 *     ratingMin: number, ratingMax: number, scoreMin: number, scoreMax: number,
 *     tierThresholds: { STRONG_MATCH_MIN: number, POTENTIAL_MATCH_MIN: number },
 *     fitCategories: string[],
 *   },
 *   eliminationRules: { types: string[], onMissingModes: string[], descriptors: Record<string, any> },
 *   candidates: { statuses: string[], maxStatusIds: number },
 *   jobs: { statuses: string[] },
 *   pagination: { defaultPageSize: number, maxPageSize: number },
 * }}
 */
export function useConfig() {
  const config = useContext(ConfigContext);
  if (config === null) {
    throw new Error('useConfig() was called outside <ConfigProvider>.');
  }
  return config;
}

/**
 * @param {{ children: import('react').ReactNode }} props
 */
export function ConfigProvider({ children }) {
  const fetcher = useCallback((signal) => getConfig({ signal }), []);
  const { data, loading, error, reload } = useResource(fetcher);
  const isSlow = useSlowRequest(loading);

  if (loading) {
    return (
      <div className="app-gate">
        <Spinner label="Loading screening settings" />
        {/*
          Only once the wait is already abnormal - see `useSlowRequest`. The
          deployed API sleeps after fifteen minutes of inactivity and the next
          request pays a cold start of up to a minute, and this is the one screen
          that always goes first, so this is where it gets explained. Naming it
          is the stronger move: an unexplained fifty-second spinner reads as
          broken, and a sentence that says what is happening reads as someone who
          knows what they deployed.
        */}
        {isSlow ? (
          <p className="app-gate__hint">
            Waking the free-tier API — this takes up to a minute on first load.
          </p>
        ) : null}
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="app-gate">
        <ErrorState
          title="The screening settings could not be loaded"
          error={error}
          hint="Upload limits, tier bands and elimination-rule definitions all come from the API, so nothing can be shown until it answers."
          onRetry={reload}
        />
      </div>
    );
  }

  return <ConfigContext.Provider value={data}>{children}</ConfigContext.Provider>;
}
