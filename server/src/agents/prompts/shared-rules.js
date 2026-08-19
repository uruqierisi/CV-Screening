/**
 * Prompt fragments used by more than one prompt, plus the retry notice.
 *
 * Every export is a function returning a string. Nothing here branches on
 * anything except its arguments, and no prompt text lives anywhere but in
 * `prompts/` - so the wording can be iterated on without touching a file that
 * has tests about behaviour.
 *
 * The fragments are separate functions rather than one blob because the two
 * prompts genuinely need different subsets: extraction is a transcription task
 * that must be told `null` is an answer, and evaluation is a judging task that
 * must be told it is not allowed to produce the number.
 */

/**
 * How the model is expected to answer, for both calls.
 *
 * The schema is enforced by the API, so this is not what makes the output valid -
 * it is what stops the model wrapping valid JSON in an explanation, which is the
 * most common way a structured-output call gets thrown away.
 *
 * @returns {string}
 */
export function outputContractRule() {
  return [
    'Return exactly one JSON object matching the provided schema. No preamble, no',
    'commentary after it, no markdown fence. Every field in the schema must be',
    'present. Do not add a field the schema does not define - the response is',
    'validated strictly and an extra key fails the whole document.',
  ].join(' ');
}

/**
 * The anti-fabrication rule, in the form that works: name the honest option
 * first, and make the dishonest one more work.
 *
 * @returns {string}
 */
export function noFabricationRule() {
  return [
    'Report only what the source in front of you says. Do not infer, complete, or',
    'improve on it. If something is not there, say it is not there - that answer',
    'is always available to you and it is always acceptable. A gap you report is',
    'useful; a gap you fill is a mistake nobody downstream can detect.',
  ].join(' ');
}

/**
 * **The primary control on numbers in the summary.**
 *
 * `scoring/validate-summary.js` is the backstop, and it is deliberately narrow:
 * it rejects the literal forms a drifting model actually produces and leaves
 * counts alone, because a false rejection burns a retry and real API spend on a
 * summary that was correct. Its own header lists what it knowingly misses -
 * spelled-out numbers ("rated them eight"), verbs outside its list ("gave them a
 * 9"), noun forms ("assessment: 85"), and oblique paraphrase ("about
 * four-fifths of what we are looking for").
 *
 * This text is what covers those. So it is written to forbid the **claim**
 * rather than the notation: any figure, in digits or in words, that expresses
 * how well the candidate matches. It also gives the model the rule it can
 * actually apply - a number that counts something is fine, a number that scores
 * the candidate is not - and the reason, because a rule with a reason survives
 * paraphrase and a rule without one gets optimised around.
 *
 * @returns {string}
 */
export function summaryMustNotStateAScore() {
  return [
    'THE SUMMARY MUST NOT STATE A SCORE.',
    '',
    'The summary is prose. It must not contain any figure that expresses how well',
    'this candidate matches the role - no score, no percentage, no rating, no',
    'overall or out-of-ten figure, and no restatement of the ratings you just',
    'gave.',
    '',
    'This is a rule about the claim, not about the notation: no such figure, in',
    'digits or in words. Writing the number as a word instead of a digit does not',
    'make it allowed, and neither does hiding it in a fraction, a verb or a label.',
    'Every one of the following is forbidden, and the list is illustrative rather',
    'than exhaustive:',
    '',
    '- in digits: "an 80% match", "scores 73", "8/10", "rated 8", "a score of 85"',
    '- spelled out: "rated them eight", "an eight out of ten", "a strong nine",',
    '  "about four-fifths of what we are looking for"',
    '- with any verb at all: "gave them a 9", "put them at 85", "landed on a 7",',
    '  "came out at 80", "I would place them around 8"',
    '- with any noun at all: "assessment: 85", "overall rating: 8", "final figure',
    '  of 73", "match: 90%", "their number is 7"',
    '- hedged: "roughly 80%", "about an 8", "somewhere near 85", "a low seven"',
    '',
    'The reason is not stylistic. This system computes the match score itself, in',
    'code, from your per-criterion ratings and a set of weights you have not been',
    'shown. Any figure you state will disagree with the computed one, and a',
    'recruiter looking at two different numbers has no way to tell which is real.',
    'Your ratings are the input to that calculation; the calculation is not yours',
    'to do.',
    '',
    'Numbers that count things are welcome and often necessary: "eight years in',
    'regulated manufacturing", "meets four of the six criteria", "led a team of',
    'twelve", "two of their three certifications are current", "shipped three',
    'production services". The test is one question. Does this number count',
    'something the profile states, or does it grade the candidate? Counting is',
    'fine. Grading is not.',
    '',
    'If you are about to write a figure and it answers "how good is this candidate',
    'overall", delete it and write the sentence without it. The sentence is always',
    'better without it.',
  ].join('\n');
}

/**
 * @typedef {object} RetryIssue
 * @property {string} path where in the response the problem was
 * @property {string} message what was wrong with it
 */

/**
 * The correction appended to the user turn on the single semantic retry.
 *
 * Feeding the error back is the difference between a retry and a coin toss: the
 * same prompt that produced an invalid response will usually produce another
 * one, and a model told exactly which field failed usually fixes that field.
 *
 * Appended to the original user message rather than sent as a second user turn:
 * assistant prefill returns 400 on this model family, and a bare second user
 * turn changes the conversation shape for no benefit. One message keeps the
 * retry byte-comparable with the first attempt except for this block.
 *
 * @param {object} params
 * @param {string} params.problem one line, in plain language
 * @param {RetryIssue[]} [params.issues] the specific fields at fault, if known
 * @returns {string}
 */
export function retryNotice({ problem, issues = [] }) {
  const lines = [
    '',
    'CORRECTION - your previous response to this exact request was rejected.',
    '',
    `What was wrong: ${problem}`,
  ];

  if (issues.length > 0) {
    lines.push('', 'Specifically:');
    for (const issue of issues) {
      lines.push(`- ${issue.path === '' ? '(the object itself)' : issue.path}: ${issue.message}`);
    }
  }

  lines.push(
    '',
    'Produce the whole response again, corrected. Do not apologise, do not explain',
    'the correction, and do not return a partial document - the full JSON object is',
    'expected, exactly as the schema describes it.',
  );

  return lines.join('\n');
}
