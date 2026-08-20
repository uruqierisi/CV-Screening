import { describe, expect, it } from 'vitest';
import {
  toCandidateDetailDto,
  toCandidateListDto,
  toCandidateStatusDto,
  toUploadedCandidateDto,
} from '../../src/http/dto/candidateDto.js';
import { toRoleDto } from '../../src/http/dto/roleDto.js';

/**
 * The response shapes.
 *
 * Two of these assertions are contract decisions rather than serialization
 * details, and they are the reason this file exists: `aiJustification` belongs
 * to the detail payload and to nothing else, and `rawText` is absent - not null -
 * unless it was asked for.
 */

const NOW = new Date('2026-08-20T10:00:00.000Z');

/** A candidate row as the repository returns one. */
function candidateRow(overrides = {}) {
  return {
    id: 'c1',
    roleId: 'r1',
    jobId: 'j1',
    originalFilename: 'jane-doe-cv.pdf',
    candidateName: 'Jane Doe',
    storagePath: 'aa/bb/c1.pdf',
    contentSha256: 'a'.repeat(64),
    mimeType: 'application/pdf',
    byteSize: 128_000,
    status: 'done',
    parsedProfile: { fullName: 'Jane Doe' },
    evaluationMatrix: { scoreRaw: 880, criteria: [], computedAt: NOW.toISOString() },
    eliminationDetails: { results: [], indeterminate: [], hasIndeterminate: false },
    eliminated: false,
    eliminatedBy: null,
    matchScore: 88,
    fitCategory: 'strong_match',
    aiJustification: 'Deep backend experience with demonstrated PostgreSQL work.',
    scoredRoleVersion: 2,
    errorCode: null,
    errorMessage: null,
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

describe('the candidate list row', () => {
  it('carries exactly the fields plan section 3 names', () => {
    expect(Object.keys(toCandidateListDto(candidateRow())).sort()).toEqual(
      [
        'candidateName',
        'completedAt',
        'createdAt',
        'eliminated',
        'eliminatedBy',
        'errorCode',
        'fitCategory',
        'id',
        'jobId',
        'matchScore',
        'originalFilename',
        'roleId',
        'status',
      ].sort(),
    );
  });

  it('does NOT carry aiJustification, the profile, the matrix or the raw text', () => {
    // A 25-row page multiplied by any of these is megabytes to render a table of
    // names and scores.
    const row = toCandidateListDto(candidateRow());
    expect(row).not.toHaveProperty('aiJustification');
    expect(row).not.toHaveProperty('parsedProfile');
    expect(row).not.toHaveProperty('evaluationMatrix');
    expect(row).not.toHaveProperty('rawText');
  });

  it('keeps the score of an eliminated candidate and names the rule', () => {
    // "78 points, Unmatched, no reason" is what makes a recruiter stop trusting
    // the tool. The score survives; only the tier is forced.
    const row = toCandidateListDto(
      candidateRow({ eliminated: true, eliminatedBy: 'Current RN licence', fitCategory: 'unmatched' }),
    );
    expect(row.matchScore).toBe(88);
    expect(row.fitCategory).toBe('unmatched');
    expect(row.eliminatedBy).toBe('Current RN licence');
  });

  it('serializes dates as ISO strings and nulls as null', () => {
    const row = toCandidateListDto(candidateRow({ completedAt: null }));
    expect(row.createdAt).toBe('2026-08-20T10:00:00.000Z');
    expect(row.completedAt).toBeNull();
  });

  it('normalises a date that arrives as a string', () => {
    // The driver returns Date objects, but a row that has been through JSON -
    // a cached read, a fixture, a replayed payload - carries strings. A field
    // that is sometimes one and sometimes the other is what a client discovers
    // in production.
    const row = toCandidateListDto(
      candidateRow({ createdAt: '2026-08-20T10:00:00.000Z', completedAt: undefined }),
    );
    expect(row.createdAt).toBe('2026-08-20T10:00:00.000Z');
    expect(row.completedAt).toBeNull();
  });
});

describe('the candidate detail payload', () => {
  it('carries aiJustification - the decision plan section 3 left open twice', () => {
    // Stored since phase 1, sourced since phase 2b (the model's `summary`,
    // prose only), and until now read by nothing. It is here, and it is not in
    // the list row.
    expect(toCandidateDetailDto(candidateRow()).aiJustification).toBe(
      'Deep backend experience with demonstrated PostgreSQL work.',
    );
  });

  it('carries the evidence a recruiter reads the detail screen for', () => {
    const detail = toCandidateDetailDto(candidateRow());
    expect(detail.parsedProfile).toEqual({ fullName: 'Jane Doe' });
    expect(detail.evaluationMatrix).toMatchObject({ scoreRaw: 880 });
    expect(detail.eliminationDetails).toMatchObject({ hasIndeterminate: false });
    expect(detail.scoredRoleVersion).toBe(2);
  });

  it('omits rawText entirely unless the row carried it', () => {
    // Absent rather than null, so "not requested" and "requested but empty" stay
    // distinguishable.
    expect(toCandidateDetailDto(candidateRow())).not.toHaveProperty('rawText');
    expect(toCandidateDetailDto(candidateRow({ rawText: 'Jane Doe\n' })).rawText).toBe('Jane Doe\n');
  });

  it('returns a failed candidate with its worker-side code and message', () => {
    // Inside a 200: a candidate that failed to screen is a successful read of a
    // failed candidate, and neither field is ever mapped to an HTTP status.
    const detail = toCandidateDetailDto(
      candidateRow({
        status: 'failed',
        errorCode: 'EMPTY_DOCUMENT',
        errorMessage: 'This PDF appears to be a scanned image.',
        matchScore: null,
        fitCategory: null,
        parsedProfile: null,
      }),
    );
    expect(detail.errorCode).toBe('EMPTY_DOCUMENT');
    expect(detail.errorMessage).toBe('This PDF appears to be a scanned image.');
  });
});

describe('the poll payload', () => {
  it('is the smallest thing that patches a dashboard row in place', () => {
    expect(Object.keys(toCandidateStatusDto(candidateRow())).sort()).toEqual(
      [
        'candidateName',
        'completedAt',
        'eliminated',
        'eliminatedBy',
        'errorCode',
        'fitCategory',
        'id',
        'matchScore',
        'status',
        'updatedAt',
      ].sort(),
    );
  });
});

describe('the upload entry', () => {
  it('flags a duplicate and reports the candidate real status', () => {
    // Not a hard-coded "pending": a duplicate of something already screened is
    // `done`, and saying otherwise sends the dashboard into a poll for work that
    // finished last week.
    expect(toUploadedCandidateDto({ candidate: candidateRow(), created: false })).toEqual({
      id: 'c1',
      originalFilename: 'jane-doe-cv.pdf',
      status: 'done',
      duplicate: true,
    });
  });

  it('reports a new candidate as not a duplicate', () => {
    expect(
      toUploadedCandidateDto({ candidate: candidateRow({ status: 'pending' }), created: true }),
    ).toMatchObject({ status: 'pending', duplicate: false });
  });
});

describe('the role payload', () => {
  it('reports the version and whether the role is archived', () => {
    const dto = toRoleDto({
      role: {
        id: 'r1',
        title: 'Senior Backend Engineer',
        description: 'Builds the API.',
        version: 3,
        archivedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      criteria: [{ id: 'c1', roleId: 'r1', label: 'Depth', description: '', weight: 100, position: 0 }],
      eliminationRules: [
        {
          id: 'e1',
          roleId: 'r1',
          label: 'Five years',
          type: 'min_years_experience',
          value: { years: 5 },
          onMissing: 'flag',
          position: 0,
        },
      ],
    });

    expect(dto.version).toBe(3);
    expect(dto.archived).toBe(true);
    expect(dto.archivedAt).toBe('2026-08-20T10:00:00.000Z');
    expect(dto.criteria[0]).toEqual({
      id: 'c1',
      label: 'Depth',
      description: '',
      weight: 100,
      position: 0,
    });
    expect(dto.eliminationRules[0].value).toEqual({ years: 5 });
    // `roleId` on a child of a role it is nested inside is noise.
    expect(dto.criteria[0]).not.toHaveProperty('roleId');
  });

  it('normalises role dates that arrive as strings', () => {
    const dto = toRoleDto({
      role: {
        id: 'r1',
        title: 'X',
        description: '',
        version: 1,
        archivedAt: '2026-08-20T10:00:00.000Z',
        createdAt: '2026-08-20T10:00:00.000Z',
        updatedAt: NOW,
      },
      criteria: [],
      eliminationRules: [],
    });
    expect(dto.archivedAt).toBe('2026-08-20T10:00:00.000Z');
    expect(dto.createdAt).toBe('2026-08-20T10:00:00.000Z');
  });

  it('reports a live role as not archived', () => {
    const dto = toRoleDto({
      role: {
        id: 'r1',
        title: 'X',
        description: '',
        version: 1,
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      criteria: [],
      eliminationRules: [],
    });
    expect(dto.archived).toBe(false);
    expect(dto.archivedAt).toBeNull();
  });
});
