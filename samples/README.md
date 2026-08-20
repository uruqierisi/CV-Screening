# Sample CVs

Six files a reviewer can upload immediately. Between them they exercise all three
supported formats, one known limitation, and one deliberate failure.

Upload them against the seeded **Senior Backend Engineer (Node.js)** role — the elimination
rules there (5 years' experience, demonstrated PostgreSQL, UK/IE/DE work authorisation) are
what these CVs are written against. Screening a CV spends real Anthropic tokens: roughly
**$0.12 per candidate** on `claude-opus-5` (measured — see the README's cost section).

| File | Format | What it demonstrates |
|---|---|---|
| `demonstrated-evidence.txt` | TXT | Every skill tied to a piece of work — the `demonstrated` side of the evidence rule |
| `clean.pdf` | PDF | A well-formed single-column PDF, and the `listed_only` side of the same rule |
| `cv.docx` | DOCX | Word document parsing |
| `cv.txt` | TXT | Plain text, with the CRLF line endings a real Windows export carries |
| `two-column.pdf` | PDF | **Known limitation** — a two-column *table* layout that interleaves |
| `scanned.pdf` | PDF | **Deliberate failure** — an image-only PDF with no text layer |

Every name in these files is invented. No real person's data is in this repository.

---

## The pair that shows the scoring rule

`demonstrated-evidence.txt` and `clean.pdf` are the two worth uploading together. Both
describe a senior backend engineer with nine or ten years in Node.js and PostgreSQL. They
differ in one respect, and it is the respect the whole scoring design turns on.

**`clean.pdf`** (Priya Ramanathan, Northwind Payments) mentions Node.js twice: once in the
profile summary, once in the skills list. The work bullets describe a ledger migration and an
idempotency layer without naming the runtime they were built in.

**`demonstrated-evidence.txt`** (Rose Okonkwo, Ardent Ledger) names the runtime inside the
work: heap profiling that cut RSS from 3.1 GB to 240 MB, indexes added after reading
`pg_stat_statements`, contract tests against two named consumers.

The extraction step labels each skill `demonstrated` or `listed_only`, and the evaluation
prompt is told that *"a skill with `evidenceType: listed_only` is a claim, not a
demonstration."* So a keyword list cannot buy a rating.

**`clean.pdf` has been screened end to end and scored 50 — Unmatched.** *Backend engineering
depth (Node.js)* was rated **3/10**, on the stated grounds that the CV never connects Node.js
to anything the candidate did. That criterion carries 30% of the weight, so it accounts for 21
of the 50 points lost. This is the measured second datapoint in §8 of
[`docs/PHASE-0-PLAN.md`](../docs/PHASE-0-PLAN.md), and it is recorded because a reviewer who
saw a 50 without explanation would reasonably conclude the scoring is broken. It is not — the
system is deliberately stricter than a human recruiter, who would read "Senior Backend
Engineer at a payments company" and infer the rest.

**`demonstrated-evidence.txt` has not been screened.** It was written to be the contrast case
and no score is claimed for it. Upload it next to `clean.pdf` and the gap between them is the
evidence rule doing its work — which is the open question §8 leaves on the table: whether that
rule is calibrated or overtuned. Settling it needs 30–50 labelled CVs, not two.

## `two-column.pdf` — the limitation you can watch happen

A CV laid out as a two-column **table**. It extracts to 320 characters that read:

```
EXPERIENCE SKILLS
Senior Backend Engineer Node.js
Northwind Payments PostgreSQL
January 2019 - present Redis
```

A job title welded to a technology, a date range welded to a skill. The cause is the PDF
producer's content-stream order, not the visual layout: column *sections* (Word columns,
LaTeX `multicol`) emit one column's text before the next and extract perfectly. "Two-column
CV" is not the predictor; "two-column table" is.

The interleaved text still passes the input guard and still reaches the model, so the
candidate **is** scored — with low ratings whose reasons cite the mangled evidence. That is
the intended failure mode: a degraded rating a human can see is wrong beats a silent
disappearance into Unmatched. Column reconstruction was declined, and §8 says why.

## `scanned.pdf` — the deliberate failure

A single page of image data with no text layer, the shape a phone-photographed or
flatbed-scanned CV takes. Extraction fails before any API call is made:

```
EMPTY_DOCUMENT — "This PDF appears to be a scanned image; no extractable
text layer was found. Re-upload a text-based PDF or a DOCX."
```

The candidate row lands in `failed` with that code, the dashboard's Processing panel shows it
with the message above, and no tokens are spent. **This is working correctly.** OCR was
declined on purpose — the reasoning is in the README's limitations section.

---

## Where these bytes come from

The five files other than `demonstrated-evidence.txt` are byte-identical copies of the parser
fixtures in `server/test/extraction/fixtures/documents/`, which are generated by
`server/test/extraction/fixtures/build-documents.js` and regenerated with
`npm run fixtures:documents`.

They are generated rather than hand-made binaries because the interesting property of
`two-column.pdf` is the order its content stream emits the columns in — invisible in a binary,
obvious in the array that builds it. `fixtures.test.js` asserts that what is committed here
and under `server/test/` both match what the generator produces, so these copies cannot drift.
