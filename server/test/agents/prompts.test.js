import { describe, expect, it } from 'vitest';
import {
  noFabricationRule,
  outputContractRule,
  retryNotice,
  summaryMustNotStateAScore,
} from '../../src/agents/prompts/shared-rules.js';
import {
  EXTRACTION_PROMPT_VERSION,
  extractionPrompt,
} from '../../src/agents/prompts/extraction.prompt.js';
import { evaluationPrompt } from '../../src/agents/prompts/evaluation.prompt.js';
import { findScoreFigure } from '../../src/agents/scoring/validate-summary.js';
import { EDUCATION_LEVELS, EVIDENCE_TYPES } from '../../src/agents/constants.js';
import { extractedProfileSchema } from '../../src/agents/schemas/profile.schema.js';
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

  it('says leaving a field out is a correct answer, not a failure', () => {
    // The single load-bearing line of the anti-fabrication story. It used to say
    // `null`; the schema now marks an absent fact by omitting the key, because a
    // nullable field compiles to a union and the API caps a schema at sixteen of
    // them. The instruction has to follow the schema, or the model is being told
    // one thing and validated against another.
    expect(system).toMatch(/Omitting a field is a correct answer, not a failure/);
    expect(system).toMatch(/never substitute a\s*\n?placeholder/i);
    // And no leftover instruction to send the thing the schema now rejects.
    expect(system).not.toMatch(/`null`/);
  });

  it('names the flat location fields the schema actually defines', () => {
    // Flattening `location` was a wire decision, and the prompt is the only
    // place the model learns about it. `locationRaw` was deleted from the schema
    // and had to leave the prompt with it, or the model would be filling in a
    // field that no longer exists and every extraction would fail on a strict
    // object.
    for (const field of ['locationCity', 'locationRegion', 'locationCountryCode']) {
      expect(system).toContain(field);
    }
    expect(system).not.toContain('locationRaw');
    expect(system).toMatch(/ISO-3166-1 alpha-2/);
  });

  it('tells the model that an empty list is how a missing section is reported', () => {
    // The four lists are required on the wire now, so omission is no longer
    // available and the prompt has to say what replaced it. Without this the
    // model would either omit a list - a validation failure and a wasted retry -
    // or invent an entry to fill one, which is the failure this system exists to
    // prevent.
    expect(system).toMatch(/`workHistory`, `education`, `certifications` and `skills` are always/);
    expect(system).toMatch(/When the CV has no such section, send an empty list/);
    expect(system).toMatch(/Never invent an entry to avoid one/);
  });

  it('tells the model that leaving out an end date means the role is current', () => {
    // `isCurrent` was deleted, so absence of `endDate` is the only encoding
    // left. `compute-experience.js` reads it that way, and an instruction that
    // did not say so would leave the model guessing which absence it was
    // spelling - and a wrong guess adds years to somebody's experience.
    expect(system).toMatch(/Leave `endDate` out of a work-history entry when the candidate is still/);
    expect(system).toMatch(/do not leave `endDate` out of a role that\s*\n?has finished/);
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

  it('carries the shared anti-fabrication rule rather than its own copy of it', () => {
    expect(system).toContain(noFabricationRule());
  });

  it('does not tell the model a schema is attached, because none is', () => {
    // `outputContractRule()` says the answer is checked against "the provided
    // schema". That was true while extraction sent `output_config.format` and is
    // false now, and an instruction the model can see is false invites the rest
    // of the prompt to be read as approximate. Evaluation still uses it.
    expect(system).not.toContain(outputContractRule());
    expect(system).not.toMatch(/provided schema/i);
  });
});

/**
 * The two things the decoding grammar used to do, now done by prompt text.
 *
 * Extraction sends no `output_config.format` (plan section 5.2), so nothing but
 * these instructions stands between the model and a response that is JSON
 * wrapped in an apology. They are tested harder than the rest of the prompt
 * because breaking one is not a wording regression - it is a decoder regression.
 */
describe('the extraction prompt, now that it carries what the schema used to', () => {
  const { system, user } = extractionPrompt({ cvText: GOLDEN_CV_TEXT });

  it('demands JSON and nothing else, in the three ways a model gets this wrong', () => {
    // A preamble, a trailing remark, and a code fence. `json-response.js` strips
    // a leading fence defensively, but a strip is a backstop for a fraction of a
    // percent; this instruction is the actual control.
    expect(system).toMatch(/WHOLE RESPONSE IS ONE JSON OBJECT/);
    expect(system).toMatch(/No preamble, no explanation, no/);
    expect(system).toMatch(/commentary after it, and no markdown code fence/);
    expect(system).toMatch(/first\s*\n?character you write is the opening brace/);
    // And once more where the model is actually asked to answer.
    expect(user).toMatch(/Answer with the JSON object alone/);
  });

  it('forbids keys the schema does not define, which strict parsing enforces', () => {
    // `extractedProfileSchema` is `.strict()`, so an invented key fails the whole
    // document. Without a grammar the model can now emit one, so it has to be
    // told - and told what it costs.
    expect(system).toMatch(/Use exactly the keys shown below/);
    expect(system).toMatch(/validated strictly and one unknown\s*\n?key fails the whole document/);
  });

  /**
   * The drift guard for a hand-written shape block.
   *
   * Writing the shape out in prose is the right call - a pasted JSON Schema
   * spends hundreds of tokens teaching the model to read
   * `additionalProperties: false` instead of showing it the answer - but it
   * creates the one surface a generated block would not have: a field can be
   * added to the schema and forgotten in the prompt, and the model would then
   * never emit it. So the two are compared here, in both directions.
   *
   * The JSON skeleton is the only place in this prompt that writes `"key":`, so
   * scanning the whole system text for that pattern collects exactly the block's
   * keys and nothing else.
   */
  describe('the shape block and the schema describe the same fields', () => {
    /** @param {any} schema @returns {any} the inner type of any wrapper */
    const unwrap = (schema) => {
      let current = schema;
      // ZodEffects (`z.preprocess`), ZodOptional and ZodArray all hide the thing
      // this walk is actually after.
      while (current?._def?.schema ?? current?._def?.innerType ?? current?._def?.type) {
        current = current._def.schema ?? current._def.innerType ?? current._def.type;
      }
      return current;
    };

    /** @param {any} objectSchema @returns {string[]} */
    const fieldNames = (objectSchema) => {
      const shape = objectSchema._def.shape();
      return Object.entries(shape).flatMap(([name, value]) => {
        const inner = unwrap(value);
        const nested = inner?._def?.shape === undefined ? [] : fieldNames(inner);
        return [name, ...nested];
      });
    };

    const schemaFields = [...new Set(fieldNames(extractedProfileSchema))].sort();
    const promptFields = [...new Set([...system.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]))]
      .sort();

    it('finds a shape block to compare, rather than passing on an empty set', () => {
      expect(promptFields.length).toBeGreaterThan(15);
      expect(schemaFields.length).toBe(promptFields.length);
    });

    it('names every field the schema defines, and no field it does not', () => {
      expect(promptFields).toEqual(schemaFields);
    });

    it('spells the two closed sets from the constants rather than by hand', () => {
      // A hand-typed copy of a closed set is a copy that goes stale, and a
      // `level` the enum does not accept fails the whole document.
      for (const level of EDUCATION_LEVELS) {
        expect(system).toContain(`"${level}"`);
      }
      for (const type of EVIDENCE_TYPES) {
        expect(system).toContain(`"${type}"`);
      }
    });

    it('says which keys are always present, since `required` is no longer sent', () => {
      expect(system).toMatch(/The four lists .* are/);
      expect(system).toMatch(/`name` on a certification, and `name` and/);
      expect(system).toMatch(/Every other key is optional/);
      // And that a list holds as many entries as the CV describes - a skeleton
      // showing one entry is otherwise readable as a limit of one.
      expect(system).toMatch(/not a limit of one/);
    });
  });

  it('is version 2.1.0: same document, different way of asking for it', () => {
    // Asserted rather than pattern-matched, because the version is stored beside
    // every extraction and is what makes two profiles comparable. A minor bump
    // says the field set and the absence convention are unchanged - only the
    // instructions that replace the grammar are new. Changing this number should
    // take a deliberate edit with a reviewer attached.
    expect(EXTRACTION_PROMPT_VERSION).toBe('2.1.0');
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
