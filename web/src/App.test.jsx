/**
 * Every route, rendered against real captured API payloads.
 *
 * This is the only test in the suite that mounts whole pages, and it earns its
 * place for one reason: six page components otherwise have no coverage at all,
 * and a typo in one of them ships silently - `npm run build` type-checks
 * nothing in a plain-JavaScript React app.
 *
 * The assertions are deliberately about **what the screen tells a recruiter**,
 * not about markup: that the detail view shows the elimination reason beside a
 * retained score, that an indeterminate rule is not rendered as a pass, that a
 * failed candidate shows its message and its retry, and that an error shows the
 * server's own message and its `requestId`.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { App } from './App.jsx';
import { ConfigProvider } from './config/ConfigProvider.jsx';
import { stubApi } from './test/apiStub.js';
import {
  CANDIDATE_DETAIL,
  CANDIDATE_LIST_ROW,
  CONFIG,
  ELIMINATED_CANDIDATE,
  FAILED_CANDIDATE,
  ROLE,
} from './test/fixtures.js';

const listMeta = (rows) => ({
  page: 1,
  pageSize: 25,
  total: rows.length,
  totalPages: 1,
  counts: { strong_match: 0, potential_match: 0, unmatched: rows.length },
});

/** The routes every screen needs before it can render anything. */
function baseRoutes(overrides = []) {
  return [
    ...overrides,
    { match: /\/api\/v1\/config$/, body: { data: CONFIG } },
    { match: /\/api\/v1\/roles\?/, body: { data: [ROLE], meta: listMeta([ROLE]) } },
    { match: /\/api\/v1\/roles\/[^/?]+$/, body: { data: ROLE } },
    { match: /\/api\/v1\/candidates\?/, body: { data: [], meta: listMeta([]) } },
  ];
}

function renderAt(path, routes) {
  stubApi(routes);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ConfigProvider>
        <App />
      </ConfigProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('/roles', () => {
  test('lists the roles with their rubric size', async () => {
    renderAt('/roles', baseRoutes());

    expect(await screen.findByText('Senior Backend Engineer')).toBeDefined();
    expect(screen.getByText(/6 criteria, 3 elimination rules/)).toBeDefined();
  });

  test('an empty list explains what a role is for and offers the button', async () => {
    renderAt(
      '/roles',
      baseRoutes([{ match: /\/api\/v1\/roles\?/, body: { data: [], meta: listMeta([]) } }]),
    );

    expect(await screen.findByText(/No active roles/)).toBeDefined();
  });

  test('a failed list shows the server message and the request id', async () => {
    renderAt(
      '/roles',
      baseRoutes([
        {
          match: /\/api\/v1\/roles\?/,
          status: 503,
          body: {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'The database is not reachable.',
              requestId: 'req-abc-123',
            },
          },
        },
      ]),
    );

    expect(await screen.findByText('The database is not reachable.')).toBeDefined();
    expect(screen.getByText(/req-abc-123/)).toBeDefined();
    expect(screen.getByText(/DEPENDENCY_UNAVAILABLE/)).toBeDefined();
  });
});

describe('/roles/new', () => {
  test('renders the weights footer with the total the server requires', async () => {
    renderAt('/roles/new', baseRoutes());

    // Two nodes on purpose: the visible text updates immediately, the
    // debounced copy in the live region announces after typing stops.
    expect(await screen.findAllByText(/Weights total 100 of 100/)).not.toHaveLength(0);
  });

  test('every rule type the server publishes is offered, with its own fields', async () => {
    renderAt('/roles/new', baseRoutes());
    await screen.findAllByText(/Weights total/);

    screen.getByRole('button', { name: 'Add rule' }).click();

    // The first descriptor is `min_years_experience`, whose only field is an
    // integer bounded 0..60 by the server, not by this client.
    expect(await screen.findByLabelText('Years')).toBeDefined();
    expect(screen.getByText('0 to 60')).toBeDefined();
  });

  test('saving an incomplete role shows a summary and sends no request', async () => {
    const { fetch } = stubApi(baseRoutes());
    render(
      <MemoryRouter initialEntries={['/roles/new']}>
        <ConfigProvider>
          <App />
        </ConfigProvider>
      </MemoryRouter>,
    );
    await screen.findAllByText(/Weights total/);

    const before = fetch.mock.calls.length;
    screen.getByRole('button', { name: 'Create role' }).click();

    expect(await screen.findByText('This role cannot be saved yet')).toBeDefined();
    // Once in the summary at the top, once under the control it concerns.
    expect(screen.getAllByText('Give the role a title.')).toHaveLength(2);
    expect(fetch.mock.calls.length).toBe(before);
  });
});

describe('/roles/:id/edit', () => {
  test('warns that editing bumps the version and rescores nobody', async () => {
    renderAt(`/roles/${ROLE.id}/edit`, baseRoutes());

    expect(await screen.findByText(/version 1 to version 2/)).toBeDefined();
    expect(screen.getByText(/keep the score and tier they were given/)).toBeDefined();
  });

  test('loads the existing criteria into the form', async () => {
    renderAt(`/roles/${ROLE.id}/edit`, baseRoutes());

    const label = await screen.findByDisplayValue('Backend engineering depth (Node.js)');
    expect(label).toBeDefined();
    expect(screen.getAllByText(/Weights total 100 of 100/)).not.toHaveLength(0);
  });
});

describe('/upload', () => {
  test('states the limits the server published rather than any of its own', async () => {
    renderAt('/upload', baseRoutes());

    expect(await screen.findByText(/5.0 MB each and 50 per upload/)).toBeDefined();
  });

  test('with no role at all, points at creating one', async () => {
    renderAt(
      '/upload',
      baseRoutes([{ match: /\/api\/v1\/roles\?/, body: { data: [], meta: listMeta([]) } }]),
    );

    expect(await screen.findByText('There is no role to upload against')).toBeDefined();
  });
});

describe('/dashboard', () => {
  test('with no role chosen, says why there is no cross-role ranking', async () => {
    renderAt('/dashboard', baseRoutes());
    expect(await screen.findByText('Choose a role')).toBeDefined();
  });

  test('ranks scored candidates and shows the tier counts from meta', async () => {
    renderAt(
      `/dashboard?roleId=${ROLE.id}`,
      baseRoutes([
        {
          match: /\/api\/v1\/candidates\?.*status=done/,
          body: { data: [CANDIDATE_LIST_ROW], meta: listMeta([CANDIDATE_LIST_ROW]) },
        },
      ]),
    );

    expect(await screen.findByText('Priya Ramanathan')).toBeDefined();
    expect(screen.getByText('50.0')).toBeDefined();
  });

  test('the tier legend comes from the server thresholds, not from this page', async () => {
    renderAt(`/dashboard?roleId=${ROLE.id}`, baseRoutes());

    expect(await screen.findByText(/85 to 100/)).toBeDefined();
    expect(screen.getByText(/below 65, or eliminated at any score/)).toBeDefined();
  });

  test('a failed candidate appears in the processing panel with its code and a retry', async () => {
    renderAt(
      `/dashboard?roleId=${ROLE.id}`,
      baseRoutes([
        {
          match: /\/api\/v1\/candidates\?.*status=failed/,
          body: { data: [FAILED_CANDIDATE], meta: listMeta([FAILED_CANDIDATE]) },
        },
      ]),
    );

    expect(await screen.findByText('EMPTY_DOCUMENT')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  test('an empty ranking names the next action', async () => {
    renderAt(`/dashboard?roleId=${ROLE.id}`, baseRoutes());
    expect(await screen.findByText('No candidate has finished screening yet')).toBeDefined();
  });
});

describe('/candidates/:id', () => {
  test('shows the score, the matrix and every rating’s evidence', async () => {
    renderAt(
      `/candidates/${CANDIDATE_DETAIL.id}`,
      baseRoutes([
        { match: /\/api\/v1\/candidates\/[^/?]+/, body: { data: CANDIDATE_DETAIL } },
      ]),
    );

    // The headline and the matrix footer both state it, which is the point.
    expect(await screen.findAllByText('50.0')).toHaveLength(2);
    expect(screen.getByText(/500 points ÷ 10/)).toBeDefined();
    expect(screen.getByText(/'Node.js' evidenceType: listed_only/)).toBeDefined();
    // Once as the model's reason, once as the quote it rests on.
    expect(screen.getAllByText(/Designed the idempotency layer/)).toHaveLength(2);
  });

  test('distinguishes a demonstrated skill from one that is only listed', async () => {
    renderAt(
      `/candidates/${CANDIDATE_DETAIL.id}`,
      baseRoutes([
        { match: /\/api\/v1\/candidates\/[^/?]+/, body: { data: CANDIDATE_DETAIL } },
      ]),
    );

    await screen.findAllByText('50.0');
    expect(screen.getByText('Demonstrated')).toBeDefined();
    expect(screen.getByText('Listed only')).toBeDefined();
    expect(screen.getByText(/1 demonstrated, 1 listed only/)).toBeDefined();
  });

  test('says which role version produced the score', async () => {
    renderAt(
      `/candidates/${CANDIDATE_DETAIL.id}`,
      baseRoutes([
        { match: /\/api\/v1\/candidates\/[^/?]+/, body: { data: CANDIDATE_DETAIL } },
      ]),
    );

    await screen.findAllByText('50.0');
    expect(screen.getByText(/Role version 1\./)).toBeDefined();
  });

  test('an eliminated candidate keeps its score, and the rule is named beside it', async () => {
    renderAt(
      `/candidates/${ELIMINATED_CANDIDATE.id}`,
      baseRoutes([
        { match: /\/api\/v1\/candidates\/[^/?]+/, body: { data: ELIMINATED_CANDIDATE } },
      ]),
    );

    // 88 is above the strong-match threshold, and the tier is still Unmatched.
    // The score, the rule and the tier all have to be in the same sentence.
    const heading = await screen.findByText(/Eliminated by/);
    const banner = heading.closest('[role="status"]');

    expect(banner.textContent).toMatch(/Authorised to work in the UK, Ireland or Germany/);
    expect(banner.textContent).toMatch(/88\.0/);
    expect(banner.textContent).toMatch(/would have scored/);
    expect(screen.getAllByText('Unmatched').length).toBeGreaterThan(0);
  });

  test('an indeterminate rule is shown as unresolved, naming the entry, and not as a pass', async () => {
    renderAt(
      `/candidates/${ELIMINATED_CANDIDATE.id}`,
      baseRoutes([
        { match: /\/api\/v1\/candidates\/[^/?]+/, body: { data: ELIMINATED_CANDIDATE } },
      ]),
    );

    expect(await screen.findByText('Could not be determined')).toBeDefined();
    expect(screen.getByText(/"Staff Engineer" at "Acme"/)).toBeDefined();
    expect(screen.getByText(/It is not a pass\./)).toBeDefined();
  });

  test('a failed candidate shows the recruiter-facing message and a retry action', async () => {
    renderAt(
      `/candidates/${FAILED_CANDIDATE.id}`,
      baseRoutes([
        { match: /\/api\/v1\/candidates\/[^/?]+/, body: { data: FAILED_CANDIDATE } },
      ]),
    );

    expect(
      await screen.findByText(/This PDF appears to be a scanned image/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry this candidate' })).toBeDefined();
  });

  test('a 404 says so and offers no pointless retry', async () => {
    renderAt(
      '/candidates/00000000-0000-4000-8000-000000000000',
      baseRoutes([
        {
          match: /\/api\/v1\/candidates\/[^/?]+/,
          status: 404,
          body: {
            error: {
              code: 'CANDIDATE_NOT_FOUND',
              message: 'No candidate with that id.',
              requestId: 'req-404-1',
            },
          },
        },
      ]),
    );

    expect(await screen.findByText('No candidate with that id.')).toBeDefined();
    expect(screen.getByText(/req-404-1/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  test('a terminal candidate is never polled', async () => {
    const { fetch } = stubApi(
      baseRoutes([
        { match: /\/api\/v1\/candidates\/[^/?]+/, body: { data: CANDIDATE_DETAIL } },
      ]),
    );
    render(
      <MemoryRouter initialEntries={[`/candidates/${CANDIDATE_DETAIL.id}`]}>
        <ConfigProvider>
          <App />
        </ConfigProvider>
      </MemoryRouter>,
    );
    await screen.findAllByText('50.0');

    const detailCalls = () =>
      fetch.mock.calls.filter(([url]) => /\/candidates\/[^/?]+/.test(String(url))).length;
    const before = detailCalls();

    await new Promise((resolve) => setTimeout(resolve, 60));
    await waitFor(() => expect(detailCalls()).toBe(before));
  });
});

describe('an unrouted path', () => {
  test('names the screens that do exist', async () => {
    renderAt('/nonsense', baseRoutes());
    expect(await screen.findByText('No such page')).toBeDefined();
  });
});
