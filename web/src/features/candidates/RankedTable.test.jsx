/**
 * What a ranked row must say, and the one it must never say silently.
 *
 * The load-bearing case is the eliminated candidate: plan section 8 requires the
 * score to survive elimination, and section 6 requires the row to name the rule.
 * A row reading "78.0, Unmatched, no reason" is the failure these assertions
 * exist to catch.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import { RankedTable } from './RankedTable.jsx';

const CANDIDATES = [
  {
    id: 'c-strong',
    candidateName: 'Ada Okafor',
    originalFilename: 'ada.pdf',
    matchScore: 88,
    fitCategory: 'strong_match',
    eliminated: false,
    eliminatedBy: null,
    completedAt: '2026-08-20T11:52:16.574Z',
  },
  {
    id: 'c-eliminated',
    candidateName: 'Priya Ramanathan',
    originalFilename: 'priya.pdf',
    // Eliminated, and still holding a score that would otherwise have been top
    // of the list. This is the whole point of retaining it.
    matchScore: 88,
    fitCategory: 'unmatched',
    eliminated: true,
    eliminatedBy: 'Current Registered Nurse (RN) licence',
    completedAt: '2026-08-20T11:52:16.574Z',
  },
  {
    id: 'c-fifty',
    candidateName: null,
    originalFilename: 'unnamed-cv.pdf',
    matchScore: 50,
    fitCategory: 'unmatched',
    eliminated: false,
    eliminatedBy: null,
    completedAt: '2026-08-20T11:52:16.574Z',
  },
];

function renderTable(props = {}) {
  return render(
    <MemoryRouter>
      <RankedTable
        candidates={CANDIDATES}
        sort="desc"
        onSortChange={() => {}}
        rankOffset={1}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('score rendering', () => {
  test('a whole-number score still shows one decimal', () => {
    renderTable();
    // `numeric(4,1)` arrives as 50, and "50" beside "81.5" reads as a different
    // kind of measurement.
    expect(screen.getByText('50.0')).toBeDefined();
    expect(screen.getAllByText('88.0')).toHaveLength(2);
  });

  test('a candidate with no name falls back to the filename rather than a blank cell', () => {
    renderTable();
    expect(screen.getByRole('link', { name: 'unnamed-cv.pdf' })).toBeDefined();
  });
});

describe('tier rendering', () => {
  test('the tier is the server’s fitCategory, never recomputed from the score', () => {
    renderTable();
    const row = screen.getByRole('row', { name: /Priya Ramanathan/ });

    // 88 is above the strong-match threshold. The badge says Unmatched because
    // the server said Unmatched, and a client that recomputed would disagree
    // with the elimination sitting next to it.
    expect(within(row).getByText('88.0')).toBeDefined();
    expect(within(row).getByText('Unmatched')).toBeDefined();
  });

  test('every tier carries a word, not just a colour', () => {
    renderTable();
    expect(screen.getByText('Strong Match')).toBeDefined();
    expect(screen.getAllByText('Unmatched')).toHaveLength(2);
  });
});

describe('the eliminated row', () => {
  test('names the rule that removed the candidate and says the score survived it', () => {
    renderTable();
    const row = screen.getByRole('row', { name: /Priya Ramanathan/ });

    expect(within(row).getByText(/Current Registered Nurse \(RN\) licence/)).toBeDefined();
    expect(within(row).getByText(/would have scored/)).toBeDefined();
  });

  test('a candidate that was not eliminated carries no elimination line', () => {
    renderTable();
    const row = screen.getByRole('row', { name: /Ada Okafor/ });
    expect(within(row).queryByText(/Eliminated by/)).toBeNull();
  });
});

describe('sorting', () => {
  test('the score header is a real button that toggles the direction', async () => {
    const onSortChange = vi.fn();
    renderTable({ onSortChange });

    const button = screen.getByRole('button', { name: /Score/ });
    button.click();

    expect(onSortChange).toHaveBeenCalledWith('asc');
  });

  test('the current direction is announced, not just drawn as an arrow', () => {
    renderTable({ sort: 'asc' });
    expect(screen.getByRole('button', { name: /sorted lowest first/ })).toBeDefined();
  });
});

describe('linking', () => {
  test('each row links to its own candidate, not to its position in the list', () => {
    // Two of these rows share a score and a tier, so a link built from anything
    // but the server id would send a recruiter to the wrong person.
    renderTable();

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .sort();

    expect(hrefs).toEqual([
      '/candidates/c-eliminated',
      '/candidates/c-fifty',
      '/candidates/c-strong',
    ]);
  });
});
