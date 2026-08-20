/**
 * The extracted profile: what the system believes the CV says.
 *
 * ## Demonstrated versus listed
 *
 * Each skill carries `evidenceType: 'demonstrated' | 'listed_only'`, and when it
 * is demonstrated it carries the verbatim quote, plus an `evidenceVerified` flag
 * set by code that substring-matched that quote against the source text. All
 * three are shown, because that distinction is what drove a plausible-looking CV
 * from a plausible-looking score to 50: a runtime named in a skills list and
 * never tied to a piece of work is a claim, not a demonstration.
 *
 * A recruiter who thinks that is too strict needs to be able to see that it is
 * what happened. Hiding it would leave them concluding the scoring is broken.
 *
 * ## Two figures for years of experience, on purpose
 *
 * `statedYearsExperience` is what the CV claims. `computedYearsExperience` is
 * what the dates support, with overlapping employment merged rather than summed -
 * and it is **null** when the dates do not determine an answer, which is never
 * shown as zero. Both are shown side by side because the gap between them is a
 * signal.
 */

import { Badge } from '../../components/Badge.jsx';
import { humanizeToken } from '../../lib/format.js';

/**
 * @param {{ profile: any }} props
 */
export function ProfilePanel({ profile }) {
  if (!profile) {
    return (
      <section className="panel">
        <h2>Extracted profile</h2>
        <p className="muted">Nothing has been extracted from this CV yet.</p>
      </section>
    );
  }

  const skills = profile.skills ?? [];
  const demonstrated = skills.filter((skill) => skill.evidenceType === 'demonstrated');
  const listedOnly = skills.filter((skill) => skill.evidenceType !== 'demonstrated');

  return (
    <>
      <section className="panel">
        <h2>Extracted profile</h2>
        <dl className="definition-list">
          <dt>Name</dt>
          <dd>{profile.fullName ?? 'Not found in the CV'}</dd>
          <dt>Email</dt>
          <dd>{profile.email ?? 'Not found in the CV'}</dd>
          <dt>Phone</dt>
          <dd>{profile.phone ?? 'Not found in the CV'}</dd>
          <dt>Location</dt>
          <dd>
            {[profile.location?.city, profile.location?.region, profile.location?.countryCode]
              .filter(Boolean)
              .join(', ') || 'Not found in the CV'}
          </dd>
          <dt>Years claimed</dt>
          <dd>
            {profile.statedYearsExperience === null || profile.statedYearsExperience === undefined
              ? 'The CV does not state a figure'
              : `${profile.statedYearsExperience} years, as the CV states it`}
          </dd>
          <dt>Years from dates</dt>
          <dd>
            {profile.computedYearsExperience === null ||
            profile.computedYearsExperience === undefined ? (
              <>
                Could not be determined from the dates.{' '}
                <span className="muted">
                  An entry with no end date that another role starts after has an unknown end, and a
                  number invented for it would be worse than admitting the gap.
                </span>
              </>
            ) : (
              <>
                {profile.computedYearsExperience} years, computed from the work history with
                overlapping roles merged rather than added.
              </>
            )}
          </dd>
        </dl>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Skills</h2>
            <p className="muted">
              {demonstrated.length} demonstrated, {listedOnly.length} listed only. A skill is
              demonstrated when the CV describes it being used, and the quote below is checked
              against the source text character for character.
            </p>
          </div>
        </div>

        {skills.length === 0 ? (
          <p className="muted">
            No skills were extracted. That is treated as an unknown rather than as "this person has
            no skills", so a required-skill rule will not eliminate on it alone.
          </p>
        ) : (
          <ul className="plain-list">
            {skills.map((skill) => (
              <li key={`${skill.name}:${skill.evidenceType}`}>
                <strong>{skill.name}</strong>{' '}
                {skill.evidenceType === 'demonstrated' ? (
                  <Badge modifier="strong">Demonstrated</Badge>
                ) : (
                  <Badge modifier="neutral">Listed only</Badge>
                )}{' '}
                {skill.evidenceVerified === false ? (
                  <Badge modifier="warn">Quote not found in the CV — downgraded</Badge>
                ) : null}
                {skill.evidenceQuote ? (
                  <blockquote className="matrix__evidence">{skill.evidenceQuote}</blockquote>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Work history</h2>
        {(profile.workHistory ?? []).length === 0 ? (
          <p className="muted">No work history was extracted from this CV.</p>
        ) : (
          <ol className="timeline">
            {profile.workHistory.map((entry, index) => (
              <li key={`${entry.employer ?? 'unknown'}:${entry.startDate ?? index}`}>
                <span className="timeline__role">
                  {entry.title ?? 'Role not stated'} — {entry.employer ?? 'Employer not stated'}
                </span>
                <span className="row-subline">
                  {entry.startDate ?? 'Start date not stated'} to{' '}
                  {entry.endDate ?? 'no end date given (read as ongoing only if nothing starts later)'}
                </span>
                {entry.summary ? <p style={{ marginTop: 'var(--space-2)' }}>{entry.summary}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel">
        <h2>Education and certifications</h2>
        {(profile.education ?? []).length === 0 ? (
          <p className="muted">No education was extracted from this CV.</p>
        ) : (
          <ul className="plain-list">
            {profile.education.map((entry, index) => (
              <li key={`${entry.institution ?? 'unknown'}:${index}`}>
                <strong>
                  {entry.degree ?? 'Qualification not stated'}
                  {entry.field ? `, ${entry.field}` : ''}
                </strong>
                <span className="row-subline">
                  {entry.institution ?? 'Institution not stated'}
                  {entry.endDate ? ` — ${entry.endDate}` : ''}
                  {entry.level ? ` — mapped to ${humanizeToken(entry.level)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(profile.certifications ?? []).length === 0 ? (
          <p className="muted">No certifications were extracted from this CV.</p>
        ) : (
          <ul className="plain-list" style={{ marginTop: 'var(--space-4)' }}>
            {profile.certifications.map((entry, index) => (
              <li key={`${entry.name}:${index}`}>
                <strong>{entry.name}</strong>
                <span className="row-subline">
                  {entry.issuer ? `${entry.issuer}. ` : ''}
                  {entry.issuedDate ? `Issued ${entry.issuedDate}. ` : ''}
                  {entry.expiryDate
                    ? `Expires ${entry.expiryDate}.`
                    : 'No expiry stated, which is not the same as "does not expire".'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
