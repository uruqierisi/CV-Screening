/**
 * The matrix has to show its working, and the working has to be right.
 *
 * Two properties are asserted here that nothing else in the client asserts:
 * every rating is rendered with the verbatim evidence it rests on, and the
 * Contribution column visibly totals to the score printed at the top of the
 * page. The second one has a failure case too - a matrix that does not
 * reconcile must say so loudly rather than render a wrong sum quietly.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { EvaluationMatrix } from './EvaluationMatrix.jsx';
import { reconcileMatrix } from '../../lib/matrix.js';

/** Transcribed from a live screening: ratings 3/7 over weights 30/20. */
const MATRIX = {
  scoreRaw: 230,
  computedAt: '2026-08-20T11:51:46.733Z',
  criteria: [
    {
      criterionId: 'crit-node',
      label: 'Backend engineering depth (Node.js)',
      weight: 30,
      rating: 3,
      weightedPoints: 90,
      reason:
        'Node.js and TypeScript appear only as listed skills with no supporting quote; the profile shows senior backend work but never ties it to Node runtime behaviour.',
      evidence: "Skills: 'Node.js' and 'TypeScript' both evidenceType: listed_only",
    },
    {
      criterionId: 'crit-api',
      label: 'API and distributed systems design',
      weight: 20,
      rating: 7,
      weightedPoints: 140,
      reason: 'Designing the idempotency layer behind a public payments API is exactly that.',
      evidence: null,
    },
  ],
};

function renderMatrix(matrix = MATRIX, matchScore = 23) {
  return render(
    <EvaluationMatrix
      reconciliation={reconcileMatrix(matrix, 10)}
      matchScore={matchScore}
      divisor={10}
      computedAt={matrix.computedAt}
    />,
  );
}

describe('the arithmetic is on screen', () => {
  test('each row shows its contribution and the multiplication behind it', () => {
    renderMatrix();
    const row = screen.getByRole('row', { name: /Backend engineering depth/ });

    expect(within(row).getByText('90')).toBeDefined();
    expect(within(row).getByText('3 × 30')).toBeDefined();
  });

  test('the footer totals the contributions and divides them to the match score', () => {
    renderMatrix();
    const footerRow = screen.getByRole('row', { name: /Total/ });

    expect(within(footerRow).getByText('230')).toBeDefined();
    expect(within(footerRow).getByText('23.0')).toBeDefined();
    expect(within(footerRow).getByText(/÷ 10/)).toBeDefined();
  });

  test('the weight column totals too, so a rubric that lost a criterion is visible', () => {
    renderMatrix();
    const footerRow = screen.getByRole('row', { name: /Total/ });
    expect(within(footerRow).getByText('50')).toBeDefined();
  });
});

describe('evidence', () => {
  test('the verbatim quote is rendered with the rating it supports', () => {
    renderMatrix();
    const row = screen.getByRole('row', { name: /Backend engineering depth/ });

    expect(
      within(row).getByText(/'Node.js' and 'TypeScript' both evidenceType: listed_only/),
    ).toBeDefined();
  });

  test('the reason is rendered in full rather than truncated into a tooltip', () => {
    renderMatrix();
    expect(
      screen.getByText(/never ties it to Node runtime behaviour/),
    ).toBeDefined();
  });

  test('a rating with no evidence says so rather than looking evidenced', () => {
    renderMatrix();
    const row = screen.getByRole('row', { name: /API and distributed systems design/ });

    expect(within(row).getByText(/cited no evidence/)).toBeDefined();
  });
});

describe('when the arithmetic does not hold', () => {
  test('a mismatch between the contributions and scoreRaw raises an alert', () => {
    renderMatrix({ ...MATRIX, scoreRaw: 999 }, 99.9);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/do not add up/);
    expect(alert.textContent).toMatch(/230/);
    expect(alert.textContent).toMatch(/999/);
  });

  test('a matrix that disagrees with the stored score raises an alert', () => {
    // The matrix is internally consistent, but the candidate row says something
    // else - which means the dashboard and this page are telling a recruiter two
    // different numbers.
    renderMatrix(MATRIX, 41);
    expect(screen.getByRole('alert').textContent).toMatch(/41/);
  });

  test('a matrix that reconciles raises nothing', () => {
    renderMatrix();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
