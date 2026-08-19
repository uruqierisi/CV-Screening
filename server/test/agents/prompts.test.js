import { describe, expect, it } from 'vitest';
import {
  noFabricationRule,
  outputContractRule,
  retryNotice,
  summaryMustNotStateAScore,
} from '../../src/agents/prompts/shared-rules.js';
import { extractionPrompt } from '../../src/agents/prompts/extraction.prompt.js';
import { evaluationPrompt } from '../../src/agents/prompts/evaluation.prompt.js';
import { findScoreFigure } from '../../src/agents/scoring/validate-summary.js';
import { GOLDEN_CV_TEXT, GOLDEN_PROFILE, GOLDEN_ROLE } from './fixtures/golden.js';

/**
 * Prompt text is not code, and testing it word by word would freeze wording
 * nobody should be afraid to improve. What is tested here is narrower and worth
 * pinning: the **load-bearing instructions**, the ones the rest of the system
 * assumes are present.
 *
 * The largest section is the summary prohibition, because plan section 5.1 makes
 * it the *primary* control and `scoring/validate-summary.js` only the backstop.
 * That file's own header lists what it knowingly misses; the tests below take
 * that list, prove the backstop really does miss each one, and then prove the
 * prompt covers it. The two files are held together by this file rather than by
 * a comment in each hoping the other kept its side.
 */

describe('the summary prohibition, which is the primary control on numbers in prose', () => {
  const text = summaryMustNotStateAScore();

  it('forbids the claim rather than the notation', () => {
    expect(text).toMatch(/rule about the claim, not about the notation/i);
    expect(text).toMatch(/in\s+digits or in words/i);
    expect(text).toMatch(/no score, no percentage, no rating/i);
  });

  /**
   * Each entry is a phrasing `findScoreFigure` is documented as missing. The
   * first assertion proves the gap is real - if a future hardening of the
   * predicate closes one, this test says so rather than leaving a prompt
   * paragraph nobody can account for. The second proves the prompt covers it.
   */
  const RESIDUAL_MISSES = [
    {
      what: 'a spelled-out number',
      summary: 'I rated them eight against this role.',
      promptCovers: /rated them eight/i,
    },
    {
      what: 'a verb outside the detector\'s list',
      summary: 'I gave them a 9 for this position.',
      promptCovers: /gave them a 9/i,
    },
    {
      what: 'a noun form with no scoring verb',
      summary: 'Assessment: 85. A capable engineer with gaps in infrastructure.',
      promptCovers: /assessment: 85/i,
    },
    {
      what: 'an oblique paraphrase of a fraction',
      summary: 'About four-fifths of what we are looking for.',
      promptCovers: /four-fifths/i,
    },
  ];

  for (const { what, summary, promptCovers } of RESIDUAL_MISSES) {
    it(`covers ${what}, which the post-parse check does not catch`, () => {
      // The gap is real and deliberate: widening the regex to catch this would
      // start rejecting counts, and a false rejection costs a retry and real
      // money on a summary that was correct.
      expect(findScoreFigure(summary)).toBeNull();
      // So the prompt carries it, by example.
      expect(text).toMatch(promptCovers);
    });
  }

  it('keeps counts legal, in the same words the backstop uses', () => {
    // The prompt and the predicate have to agree about the line, or the model is
    // being told one thing and judged by another.
    expect(text).toMatch(/Numbers that count things are welcome/i);
    expect(text).toMatch(/meets four of the six criteria/i);
    expect(findScoreFigure('Meets four of the six criteria.')).toBeNull();
    expect(findScoreFigure('Eight years in regulated manufacturing.')).toBeNull();
  });

  it('gives the reason, not just the rule', () => {
    // A rule with a reason survives paraphrase; a rule without one gets
    // optimised around.
    expect(text).toMatch(/computes the match score itself, in\s*\n?code/i);
    expect(text).toMatch(/weights you have not been\s*\n?shown/i);
    expect(text).toMatch(/no way to tell which is real/i);
  });

  it('forbids restating the ratings, which is where most figures come from', () => {
    expect(text).toMatch(/no restatement of the ratings/i);
  });

  it('gives one test the model can actually apply', () => {
    expect(text).toMatch(/Counting is\s*\n?fine\. Grading is not\./i);
  });
});

describe('the extraction prompt', () => {
  const { system, user } = extractionPrompt({ cvText: GOLDEN_CV_TEXT });

  it('sees the CV and nothing else', () => {
    // Structural, not aspirational: the function takes one argument, so a role
    // cannot reach it. If that signature ever grows, this fails.
    expect(extractionPrompt.length).toBe(1);
    expect(`${system}${user}`).not.toContain(GOLDEN_ROLE.title);
    for (const criterion of GOLDEN_ROLE.criteria) {
      expect(`${system}${user}`).not.toContain(criterion.label);
    }
  });

  it('says null is a correct answer, not a failure', () => {
    // The single load-bearing line of the anti-fabrication story.
    expect(system).toMatch(/`null` is a correct answer, not a failure/);
    expect(system).toMatch(/never substitute a placeholder/i);
  });

  it('names the honest option first and makes the dishonest one more work', () => {
    const listedOnlyAt = system.indexOf('`listed_only`');
    const demonstratedAt = system.indexOf('`demonstrated` - the CV describes');
    expect(listedOnlyAt).toBeGreaterThan(-1);
    expect(listedOnlyAt).toBeLessThan(demonstratedAt);

    // And the extra work: a verbatim copy, checked by machine.
    expect(system).toMatch(/copy `evidenceQuote` verbatim - character\s*\n?for character/);
    expect(system).toMatch(/checked against the/i);
  });

  it('puts the CV last, in tags, and treats its contents as data', () => {
    expect(user.trimEnd().endsWith('</cv>')).toBe(true);
    expect(user).toContain(`<cv>\n${GOLDEN_CV_TEXT}\n</cv>`);
    // A CV containing "ignore the above" is a document, not an instruction.
    expect(user).toMatch(/never followed/i);
  });

  it('forbids computing the years total, which code does from the dates', () => {
    expect(system).toMatch(/Do not add up the roles yourself/i);
  });

  it('carries the shared rules rather than its own copy of them', () => {
    expect(system).toContain(outputContractRule());
    expect(system).toContain(noFabricationRule());
  });
});

describe('the evaluation prompt', () => {
  const criteria = GOLDEN_ROLE.criteria.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
  const { system, user } = evaluationPrompt({
    criteria,
    roleTitle: GOLDEN_ROLE.title,
    profile: GOLDEN_PROFILE,
  });

  it('withholds the weights', () => {
    // A model that knows a criterion carries 30% rates it strategically, and the
    // ratings stop being independent observations.
    //
    // The criteria are rendered in the user turn, and that turn must not mention
    // a weight at all - not the word, not the number.
    expect(user).not.toMatch(/\bweights?\b/i);
    for (const criterion of GOLDEN_ROLE.criteria) {
      expect(user).not.toContain(`weight`);
      expect(user).not.toContain(`: ${criterion.weight}`);
    }

    // The system turn says the word exactly once, and only to tell the model
    // that the weights exist and it has not been shown them - which is what
    // stops it inferring that its ratings *are* the answer.
    const mentions = system.match(/\bweights?\b/gi) ?? [];
    expect(mentions).toHaveLength(1);
    expect(system).toMatch(/weights you have not been\s*\n?shown/i);
  });

  it('withholds the elimination rules', () => {
    const whole = `${system}${user}`;
    expect(whole).not.toMatch(/eliminat/i);
    for (const rule of GOLDEN_ROLE.eliminationRules ?? []) {
      expect(whole).not.toContain(rule.label);
    }
  });

  it('withholds the raw CV', () => {
    expect(`${system}${user}`).not.toContain('cutting p99 latency from 1.8s to 240ms');
    expect(system).toMatch(/not the CV itself/i);
  });

  it('anchors every band of the scale, and refuses 5 as a shrug', () => {
    // Unanchored 0-10 scales collapse into 6-8 for everybody, which destroys the
    // ranking the product exists to produce.
    for (const band of ['0 ', '1-2', '3-4', '5-6', '7-8', '9-10']) {
      expect(system).toContain(band);
    }
    expect(system).toMatch(/Do not use 5 as a default for "unsure"/);
    expect(system).toMatch(/If the profile is silent on a\s*\n?criterion, the rating is 0/);
  });

  it('makes the evidence work pay off', () => {
    expect(system).toMatch(/`evidenceType: listed_only`\s*\n?is a claim, not a demonstration/);
  });

  it('carries the summary prohibition verbatim', () => {
    expect(system).toContain(summaryMustNotStateAScore());
  });

  it('asks for every criterion exactly once, by its real id', () => {
    for (const criterion of criteria) {
      expect(user).toContain(`id: ${criterion.id}`);
      expect(user).toContain(`label: ${criterion.label}`);
    }
    expect(user).toMatch(/must appear exactly once/i);
  });

  it('tags the profile and refuses to take instructions from it', () => {
    expect(user).toContain('<profile>');
    expect(user).toContain('</profile>');
    expect(user).toMatch(/never followed/i);
  });

  it('handles a criterion with no description without producing an empty line', () => {
    const { user: rendered } = evaluationPrompt({
      criteria: [{ id: 'c1', label: 'Only one', description: '' }],
      roleTitle: 'Role',
      profile: {},
    });
    expect(rendered).toContain('(no further description given)');
  });
});

describe('the retry notice', () => {
  it('says what was wrong and asks for the whole document again', () => {
    const notice = retryNotice({ problem: 'the response was not valid JSON' });

    expect(notice).toContain('CORRECTION');
    expect(notice).toContain('the response was not valid JSON');
    expect(notice).toMatch(/do not return a partial document/i);
    expect(notice).toMatch(/do not apologise/i);
  });

  it('names the failing fields when it knows them', () => {
    const notice = retryNotice({
      problem: 'the response did not match the required schema',
      issues: [
        { path: 'skills.0.name', message: 'Required' },
        { path: '', message: 'Unrecognized key(s) in object' },
      ],
    });

    expect(notice).toContain('- skills.0.name: Required');
    // A root-level issue has no path, and "- : Unrecognized" reads as a typo.
    expect(notice).toContain('- (the object itself): Unrecognized key(s) in object');
  });
});
