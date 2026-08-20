/**
 * Identity redaction, decision 7-D.
 *
 * The recruiter sees the whole person. The judge does not.
 *
 * `fullName`, `email`, `phone` and `linkedinUrl` are nulled on the copy of the
 * profile that goes to the **evaluation call, and nowhere else**. The stored
 * `parsed_profile`, the dashboard row, the candidate detail view and the audit
 * record are all untouched - a recruiter who cannot see a candidate's name
 * cannot do their job, and a system that quietly deleted it would be a different
 * and worse product.
 *
 * It costs no signal, and that is the argument for it rather than a hope about
 * it: no criterion in this system can legitimately reference a candidate's name
 * or contact details, so there is nothing for the ratings to lose. What it
 * removes is the model's opportunity to be influenced by what a name suggests
 * about somebody's gender, ethnicity or nationality - an influence that would be
 * invisible in the output, because the reason field would name a real skill
 * either way.
 *
 * **Institution names are deliberately not redacted.** Removing them would take
 * away signal recruiters legitimately weight, and the choice belongs to whoever
 * defines the role rather than to this file. Employer names stay for the same
 * reason.
 *
 * ## The honest limit
 *
 * This nulls four fields. It does not scrub free text, and a work-history entry
 * that begins "Priya led the migration..." carries the name into evaluation
 * through `workHistory[].summary`, as does an email address written inside a
 * bullet. Scrubbing prose would need either a name list or another model call,
 * and both would sometimes delete a real word from a real CV - "Baker" is a
 * surname and a job. The narrow version removes the identity fields the model
 * would most reliably key on; it does not claim to make the profile anonymous,
 * and the README should not claim it either.
 *
 * The leak got narrower without anyone aiming at it: the profile-level
 * `headline` and `summary` were the two free-text fields most likely to open
 * with a candidate's own name, and both were deleted when the schema was cut to
 * fit the API's optional-parameter budget (see `profile.schema.js`). That is a
 * side effect, not a control, and it is recorded here so that a future reader
 * restoring either field knows what they are also restoring.
 *
 * **The budget stopped being the reason.** Extraction no longer sends a schema at
 * all, so neither cap binds it (`profile.schema.js`, postscript), and profile
 * `summary` stays deleted on this argument instead: a free-text field that
 * routinely opens with the candidate's own name is a name-leak surface into the
 * judge, which is a better reason than the budget ever was. `headline` is the
 * same shape of field and carries the same risk, plus one of its own - it is
 * candidate self-description, and nothing in the system verifies it.
 */

/**
 * The fields removed, exported so the test asserts this list rather than a copy
 * of it that could quietly fall out of step.
 *
 * @type {readonly string[]}
 */
export const REDACTED_IDENTITY_FIELDS = Object.freeze([
  'fullName',
  'email',
  'phone',
  'linkedinUrl',
]);

/**
 * Returns a copy of the profile with the identity fields nulled.
 *
 * A copy, never a mutation. The caller is holding the profile that will be
 * stored, and a function that edited it in place would silently redact the
 * recruiter's view from the inside of the evaluation step - the exact bug this
 * module's whole design is arranged to make impossible.
 *
 * Nulled rather than deleted: every field in the schema is nullable-but-present,
 * `null` already means "not available", and deleting a key would make the
 * redacted profile fail the schema it came from.
 *
 * @template {Record<string, unknown>} T
 * @param {T} profile
 * @returns {T} a new object, with the four identity fields set to null
 */
export function redactIdentity(profile) {
  const redacted = { ...profile };
  for (const field of REDACTED_IDENTITY_FIELDS) {
    redacted[field] = null;
  }
  return /** @type {T} */ (redacted);
}
