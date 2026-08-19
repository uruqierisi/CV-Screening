import { describe, expect, it } from 'vitest';
import {
  SCORE_FIGURE_PATTERNS,
  SCORE_FIGURE_REGEXES,
  assertSummaryIsProseOnly,
  findScoreFigure,
} from '../../src/agents/scoring/validate-summary.js';
import { AgentError, SummaryContainsScoreError } from '../../src/agents/errors.js';

/**
 * The line between a count and a score is defined here, not by regex cleverness.
 *
 * Two failure modes, and they are not equally bad. Letting *"roughly an 80%
 * match"* through puts a second, invented figure next to the computed score and
 * a recruiter cannot tell which is real. Rejecting *"matches 4 of the 6
 * criteria"* burns a retry, and real API spend, on a summary that was correct.
 * The second is the more expensive mistake and the more likely one, so the
 * must-pass block below is the load-bearing half of this file.
 *
 * Every case is named for what it demonstrates, and the sentence is in the test
 * name, so a failure report reads as a specification rather than as an index
 * into an array.
 */

/**
 * Must reject. Each entry becomes one named test asserting both that the
 * summary is refused and *which* pattern refused it - a case that starts
 * failing for a different reason than it was written for is a silent hole.
 */
const MUST_REJECT = [
  {
    demonstrates: 'a percentage in symbol form, the failure the plan names by hand',
    patternId: 'percentage',
    summary: 'Roughly an 80% match for this role.',
  },
  {
    demonstrates: 'a percentage spelled as one word',
    patternId: 'percentage',
    summary: 'About 80 percent aligned.',
  },
  {
    demonstrates: 'a percentage spelled as two words',
    patternId: 'percentage',
    summary: '80 per cent aligned.',
  },
  {
    demonstrates: 'a percentage with a space before the symbol',
    patternId: 'percentage',
    summary: 'Comes out at 80 % on the rubric.',
  },
  {
    demonstrates: 'an x/10 rating, which wins over the scoring-word pattern by order',
    patternId: 'out_of_ten_or_hundred',
    summary: 'Overall I would rate them 8/10.',
  },
  {
    demonstrates: 'an x/100 rating',
    patternId: 'out_of_ten_or_hundred',
    summary: 'Scores 73/100 against the criteria.',
  },
  {
    demonstrates: 'a number bound to a score noun by "of", where the tail is an open-class verb',
    patternId: 'quantified_score_word',
    summary: 'A score of 80 seems right.',
  },
  {
    demonstrates: 'a number bound to a scoring verb with no gap at all',
    patternId: 'quantified_score_word',
    summary: 'Scores 85 overall.',
  },
  {
    demonstrates: 'a number bound to a score noun by a colon',
    patternId: 'quantified_score_word',
    summary: 'rating: 8 overall.',
  },
  {
    demonstrates: 'a number bound to "rating" by "of"',
    patternId: 'quantified_score_word',
    summary: 'A rating of 9 feels fair.',
  },
  {
    demonstrates: 'a decimal number bound to "rated" by "at"',
    patternId: 'quantified_score_word',
    summary: 'Rated at 8.5 by my reckoning.',
  },
  {
    demonstrates: 'a scoring verb with a two-word object, then a full stop',
    patternId: 'quantified_score_word',
    summary: 'I rated this candidate 8.',
  },
  {
    demonstrates: 'a modal scoring verb with a pronoun object',
    patternId: 'quantified_score_word',
    summary: 'I would score them 90.',
  },
  {
    demonstrates: 'a scoring gerund whose number is followed by the preposition "for"',
    patternId: 'quantified_score_word',
    summary: 'Scoring them 7 for this position.',
  },
  {
    demonstrates: 'the bare object form at end of string, the phrasing a model most often writes',
    patternId: 'quantified_score_word',
    summary: 'rated them 8',
  },
  {
    demonstrates: 'the bare object form in the past tense',
    patternId: 'quantified_score_word',
    summary: 'scored them 85',
  },
  {
    demonstrates: 'the bare object form in the present tense',
    patternId: 'quantified_score_word',
    summary: 'I rate them 7',
  },
  {
    demonstrates: 'a determiner plus a noun object between the verb and the number',
    patternId: 'quantified_score_word',
    summary: 'rated the applicant 8',
  },
  {
    demonstrates: 'a determiner plus a different noun object, to show no noun list is involved',
    patternId: 'quantified_score_word',
    summary: 'scored this profile 85',
  },
];

/**
 * Must pass. Sentences a good summary genuinely contains: every one has digits,
 * and every one must survive. A rejection here is a retry spent on correct work.
 */
const MUST_PASS = [
  {
    demonstrates: 'a count of criteria immediately after a matching word',
    summary: 'The candidate matches 4 of the 6 criteria.',
  },
  {
    demonstrates: 'years of experience, the most common number in any CV summary',
    summary: '8 years of experience in distributed systems.',
  },
  {
    demonstrates: 'a team size',
    summary: 'Led a team of 12.',
  },
  {
    demonstrates: 'a bare year',
    summary: 'At the company since 2019.',
  },
  {
    demonstrates: 'a fraction that is not a score scale',
    summary: 'Meets 4/6 of the stated requirements.',
  },
  {
    demonstrates: 'a date that looks like an x/10 until the trailing lookahead refuses it',
    summary: 'Joined 10/10/2023 and shipped steadily.',
  },
  {
    demonstrates: 'a scoring noun one word away from a number that counts years',
    summary: 'Their rating reflects 8 years of hands-on work.',
  },
  {
    demonstrates: 'a word that starts with "percent" but is not a percentage',
    summary: 'In the 90 percentile of applicants I have seen.',
  },
  {
    demonstrates: 'a scoring verb two words away from a number that counts criteria',
    summary: 'Scored highly across 4 criteria.',
  },
  {
    demonstrates: 'two counts of things the CV owns, with no scoring word anywhere',
    summary: 'Owns 3 services and mentors 2 juniors.',
  },
  {
    // A scoring word directly followed by a number, with no binding token: the
    // shape form one used to reject on sight. "projects" is the noun being
    // counted, so the tail is what decides, and it decides count.
    demonstrates: 'a scoring verb bound to nothing, counting the noun that follows it',
    summary: 'scored 8 projects end to end',
  },
  {
    // Same shape, and "languages" is itself a profile field - precisely the
    // sentence a model would write about a real CV.
    demonstrates: 'a zero-gap scoring verb counting a noun that is also a profile field',
    summary: 'rated 5 languages as fluent',
  },
  {
    demonstrates: 'two counts in one clause, one of them after the binding token "at"',
    summary: 'Worked at 3 companies over 11 years.',
  },
  {
    demonstrates: 'a rank: the gap is the full three words and the tail is a plain noun',
    summary: 'rated among the top 3 applicants',
  },
  {
    demonstrates: 'a scoring noun whose number counts roles, with a relative clause between',
    summary: 'a rating that covers 5 roles',
  },
  {
    demonstrates: 'a scoring word and an unrelated number far apart in one sentence',
    summary: 'Their rating is strong, and they have shipped 12 services across three teams.',
  },
  {
    demonstrates: 'a clean qualitative summary containing no digits at all',
    summary:
      'A pragmatic engineer with deep payments experience and clear written communication. ' +
      'The gaps are in team leadership, where the CV shows contribution rather than ownership.',
  },
];

describe('findScoreFigure', () => {
  describe('must reject: a figure on the score itself', () => {
    for (const { demonstrates, patternId, summary } of MUST_REJECT) {
      it(`rejects ${demonstrates} - "${summary}"`, () => {
        const found = findScoreFigure(summary);

        expect(found, summary).not.toBeNull();
        expect(found?.patternId, summary).toBe(patternId);
      });
    }
  });

  describe('must pass: counts, dates, ranks and quantities', () => {
    for (const { demonstrates, summary } of MUST_PASS) {
      it(`accepts ${demonstrates} - "${summary.slice(0, 60)}"`, () => {
        expect(findScoreFigure(summary), summary).toBeNull();
      });
    }
  });

  /**
   * The regression this file exists for. The first version of the check allowed
   * at most two words from a closed *filler* list between the scoring word and
   * the number, so `rated 8` was caught and `rated them 8` - the way a model
   * actually writes it - was not. These cases assert the object form directly,
   * separately from the matrix above, so that a future edit which re-narrows the
   * gap fails here with a name that says what broke.
   */
  describe('the object gap: a scoring verb with something in between', () => {
    it('rejects the pronoun object, which the closed filler list used to miss', () => {
      expect(findScoreFigure('rated them 8')?.patternId).toBe('quantified_score_word');
    });

    it('rejects a full sentence built around the pronoun object', () => {
      expect(findScoreFigure("I'd rate them 8 on this.")?.patternId).toBe('quantified_score_word');
    });

    it('rejects an object noun this file has never heard of, because no noun list is consulted', () => {
      // The point of the inversion: the check does not know what a "dossier" is,
      // and does not need to. The number is followed by a full stop, so it is a
      // score whatever the words before it were.
      expect(findScoreFigure('I scored this dossier 77.')?.patternId).toBe('quantified_score_word');
    });

    it('accepts a count noun this file has never heard of, for the same reason', () => {
      // `certifications` is in no list anywhere. It is an open-class word, so the
      // number in front of it is counting something and the summary survives.
      expect(findScoreFigure('Their rating reflects 6 certifications.')).toBeNull();
      expect(findScoreFigure('Scored well across 5 microservices.')).toBeNull();
    });
  });

  /**
   * The tail test, case by case. What follows the number is what decides, and
   * each branch of that decision gets a case here rather than being implied.
   */
  describe('what follows the number decides whether it is a score or a count', () => {
    it('treats end of string as a score, because nothing is being counted', () => {
      expect(findScoreFigure('scored them 85')?.patternId).toBe('quantified_score_word');
    });

    it('treats punctuation as a score', () => {
      expect(findScoreFigure('I rated this candidate 8.')?.patternId).toBe('quantified_score_word');
      expect(findScoreFigure('I rated this candidate 8, on balance.')?.patternId).toBe(
        'quantified_score_word',
      );
    });

    it('treats scale language as a score', () => {
      expect(findScoreFigure('I would rate them 8 out of 10.')?.patternId).toBe(
        'quantified_score_word',
      );
      expect(findScoreFigure('I would rate them 8 overall.')?.patternId).toBe(
        'quantified_score_word',
      );
    });

    it('treats a closed-class function word as a score', () => {
      // The residual case a plain punctuation-or-comparison inversion misses:
      // `for` is neither punctuation nor comparison language nor a noun.
      expect(findScoreFigure('Scoring them 7 for this position.')?.patternId).toBe(
        'quantified_score_word',
      );
      expect(findScoreFigure('Scoring them 7 in this round.')?.patternId).toBe(
        'quantified_score_word',
      );
      expect(findScoreFigure('Scoring them 7 and moving on.')?.patternId).toBe(
        'quantified_score_word',
      );
    });

    it('treats an open-class word as a count', () => {
      expect(findScoreFigure('Their rating reflects 8 years of hands-on work.')).toBeNull();
      expect(findScoreFigure('Scored highly across 4 criteria.')).toBeNull();
    });

    it('applies the tail test to a zero-gap scoring verb, so a bare count passes', () => {
      // The binding token is what rules out a count reading, so its absence
      // sends these to the tail rather than rejecting them outright.
      expect(findScoreFigure('scored 8 projects end to end')).toBeNull();
      expect(findScoreFigure('rated 5 languages as fluent')).toBeNull();
    });

    it('still rejects a zero-gap scoring verb when the tail says score', () => {
      // The same shape as the two counts above, decided the other way by what
      // follows the number. With no gap there is nothing to elide, so the span
      // is reported verbatim rather than as "Scores ... 85".
      expect(findScoreFigure('Scores 85 overall.')?.match).toBe('Scores 85');
      expect(findScoreFigure('rated 8, which is strong')?.match).toBe('rated 8');
      expect(findScoreFigure('rated 8')?.match).toBe('rated 8');
    });

    it('rejects a bound number regardless of the tail, because the binder rules out a count', () => {
      // "seems" is open-class; only the binding "of" keeps this a rejection.
      expect(findScoreFigure('A score of 80 seems right.')?.match).toBe('score of 80');
      expect(findScoreFigure('rating: 8 overall.')?.match).toBe('rating: 8');
    });

    it('lets "of" after the number pass, because "4 of the 6" is partitive', () => {
      // The one preposition kept out of the rejecting list, and the reason: the
      // partitive count is a sentence a correct summary really writes.
      expect(findScoreFigure('Scored highly across 4 of the 6 criteria.')).toBeNull();
    });

    it('does not consult the tail when the number is bound directly to the scoring word', () => {
      // "seems" is open-class, so the tail test would wave this through. The
      // direct-binding form rejects it without asking, which is why the check
      // has two forms rather than one.
      expect(findScoreFigure('A score of 80 seems right.')?.patternId).toBe(
        'quantified_score_word',
      );
    });
  });

  /**
   * The gap cap. Without it, any scoring word anywhere in a sentence would reach
   * any later number, and the tail test would be the only thing standing between
   * a recruiter and a false rejection.
   */
  describe('the cap on the gap between the scoring word and the number', () => {
    it('accepts a scoring word and an unrelated number far apart in one sentence', () => {
      // The negative test the cap is for. The number is a count of services and
      // sits six words from "rating"; the comma alone would also stop it.
      expect(
        findScoreFigure(
          'Their rating is strong, and they have shipped 12 services across three teams.',
        ),
      ).toBeNull();
    });

    it('accepts a distant number whose tail is score-like, so only the cap can save it', () => {
      // No punctuation in the gap and a full stop after the number: if the gap
      // were unbounded this would be rejected, and it is a correct sentence.
      expect(
        findScoreFigure('They were rated well by three separate interviewers in 2019.'),
      ).toBeNull();
    });

    it('rejects at the cap: three words between the verb and the number', () => {
      expect(findScoreFigure('I rated this senior candidate 8.')?.patternId).toBe(
        'quantified_score_word',
      );
    });

    it('accepts one word past the cap, which is the stated cost of the bound', () => {
      // Documented, not accidental: four words of object is past where a scoring
      // verb and its number reliably belong together, and the prompt-level
      // prohibition is the primary control for what slips through here.
      expect(findScoreFigure('I rated this very senior candidate 8.')).toBeNull();
    });

    it('will not let the gap cross a comma or a full stop', () => {
      // Gap words are letters only, so punctuation ends the window regardless of
      // how the cap is set.
      expect(findScoreFigure('Their rating, in short, 8.')).toBeNull();
    });
  });

  describe('scanning the whole summary', () => {
    it('rejects a summary that counts first and scores second', () => {
      // The first candidate is a count and must not end the scan, or a model
      // learns to bury the score behind a legitimate number.
      const found = findScoreFigure(
        'Their rating reflects 8 years of hands-on work, and I would score them 90.',
      );

      expect(found?.patternId).toBe('quantified_score_word');
      expect(found?.match).toBe('score ... 90');
    });

    it('accepts a summary with several counts and no score', () => {
      expect(
        findScoreFigure(
          'Their rating reflects 8 years of hands-on work across 4 criteria and 3 teams.',
        ),
      ).toBeNull();
    });
  });

  describe('null and non-prose input', () => {
    it('accepts null, because the schema allows it and absence has no number', () => {
      expect(findScoreFigure(null)).toBeNull();
    });

    it('accepts a non-string without throwing, so a bad caller fails elsewhere', () => {
      expect(findScoreFigure(/** @type {never} */ (undefined))).toBeNull();
      expect(findScoreFigure(/** @type {never} */ (42))).toBeNull();
    });

    it('accepts an empty string', () => {
      expect(findScoreFigure('')).toBeNull();
    });

    it('accepts a whitespace-only string', () => {
      expect(findScoreFigure('   ')).toBeNull();
      expect(findScoreFigure('\n\t ')).toBeNull();
    });
  });

  describe('what gets reported back', () => {
    it('reports the matched span, so a failure is debuggable', () => {
      expect(findScoreFigure('This is an 80% match overall.')).toEqual({
        patternId: 'percentage',
        description: 'a percentage, in symbol or spelled form',
        match: '80%',
      });
    });

    it('reports the directly bound span verbatim, since its alphabet is closed', () => {
      expect(findScoreFigure('A score of 80 seems right.')?.match).toBe('score of 80');
    });

    it('elides the gap in a loose match, because the gap is model prose', () => {
      // "rated <anything> 8" would put whatever the model wrote into a log line.
      expect(findScoreFigure('We rated Priya Raghunathan 8.')?.match).toBe('rated ... 8');
    });

    it('truncates a long match rather than pasting model prose into a log', () => {
      const found = findScoreFigure('Overall we would put them at approximately the 90 percent mark.');

      expect(found?.patternId).toBe('percentage');
      expect(found?.match.length).toBeLessThanOrEqual(40);
    });

    it('returns the first pattern that matches when several would', () => {
      // Percentage is tried before the x/10 form, and the order is asserted rather
      // than assumed so a reordering has to be deliberate.
      expect(findScoreFigure('An 80% match, or 8/10 if you prefer.')?.patternId).toBe('percentage');
    });

    it('carries no regex state between calls', () => {
      // A /g regex would alternate pass/fail across calls via lastIndex. This is
      // the cheapest possible guard against that bug, and it matters more now
      // that the loose form builds a global regex internally.
      const summary = 'Overall an 80% match.';
      const loose = 'I rated this candidate 8.';

      expect(findScoreFigure(summary)).not.toBeNull();
      expect(findScoreFigure(summary)).not.toBeNull();
      expect(findScoreFigure(loose)).not.toBeNull();
      expect(findScoreFigure(loose)).not.toBeNull();
      expect(findScoreFigure(loose)).not.toBeNull();
    });
  });
});

describe('SCORE_FIGURE_PATTERNS', () => {
  it('is the closed list the plan describes, in the order they are tried', () => {
    expect(SCORE_FIGURE_PATTERNS.map((entry) => entry.id)).toEqual([
      'percentage',
      'out_of_ten_or_hundred',
      'quantified_score_word',
    ]);
  });

  it('is frozen, entries and all', () => {
    expect(Object.isFrozen(SCORE_FIGURE_PATTERNS)).toBe(true);
    for (const entry of SCORE_FIGURE_PATTERNS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('exposes a finder per entry that returns a span or null', () => {
    for (const { id, find } of SCORE_FIGURE_PATTERNS) {
      expect(typeof find, id).toBe('function');
      expect(find('A pragmatic engineer with no numbers in sight.'), id).toBeNull();
    }
  });

  it('uses no global flag on any regex, which would make matching stateful', () => {
    expect(SCORE_FIGURE_REGEXES.length).toBeGreaterThan(0);
    for (const pattern of SCORE_FIGURE_REGEXES) {
      expect(pattern.global, pattern.source).toBe(false);
    }
  });

  it('is frozen as a regex list too', () => {
    expect(Object.isFrozen(SCORE_FIGURE_REGEXES)).toBe(true);
  });

  it('has a case in the must-reject matrix for every pattern', () => {
    // Keeps the suite honest: a pattern added without a test fails here rather
    // than sitting unexercised behind the coverage gate.
    expect(new Set(MUST_REJECT.map((entry) => entry.patternId))).toEqual(
      new Set(SCORE_FIGURE_PATTERNS.map((entry) => entry.id)),
    );
  });
});

describe('assertSummaryIsProseOnly', () => {
  it('returns undefined for a clean summary', () => {
    expect(assertSummaryIsProseOnly('They match 4 of the 6 criteria.')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(assertSummaryIsProseOnly(null)).toBeUndefined();
  });

  it('throws a typed error naming the pattern that matched', () => {
    let thrown = null;
    try {
      assertSummaryIsProseOnly('Overall an 80% match for this role.');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SummaryContainsScoreError);
    expect(thrown).toBeInstanceOf(AgentError);
    expect(thrown.patternId).toBe('percentage');
    expect(thrown.match).toBe('80%');
    expect(thrown.message).toContain('a percentage, in symbol or spelled form');
    expect(thrown.code).toBe('AGENT_BAD_OUTPUT');
  });

  it('labels the failure retryable, unlike every other error in the layer', () => {
    // Plan section 5.4: a validation failure of a model response goes on
    // `call-structured.js`'s semantic retry. Unlike the reconciliation errors,
    // what a retry changes is the generation, not the argument - a fresh
    // generation is very likely to be clean, and failing a candidate outright
    // over prose formatting when the ratings are sound is the worse outcome.
    expect(() => assertSummaryIsProseOnly('Rated 8 overall.')).toThrow(SummaryContainsScoreError);

    try {
      assertSummaryIsProseOnly('Rated 8 overall.');
    } catch (error) {
      expect(error.retryable).toBe(true);
    }
  });

  it('puts the pattern id and the span in details, and nothing else', () => {
    try {
      assertSummaryIsProseOnly('Taken together, about 73/100 for this position.');
    } catch (error) {
      expect(error.details).toEqual({ patternId: 'out_of_ten_or_hundred', match: '73/100' });
      expect(error.toJSON().retryable).toBe(true);
    }
  });

  it('leaks no model prose into the serialized error', () => {
    // `details` goes to the logs, and logs must not become a second copy of a
    // CV. The reported span is drawn from the pattern's own alphabet, so a name
    // planted in the summary cannot reach it.
    try {
      assertSummaryIsProseOnly('Priya Raghunathan of Acme Corp is an 80% match.');
    } catch (error) {
      const serialized = JSON.stringify(error.toJSON());
      expect(serialized).not.toContain('Priya');
      expect(serialized).not.toContain('Acme');
    }
  });

  it('leaks no model prose from the gap of a loose match either', () => {
    // The gap is the one place arbitrary prose could reach a log line, and this
    // is the case that proves it does not.
    try {
      assertSummaryIsProseOnly('We rated Priya Raghunathan 8.');
    } catch (error) {
      const serialized = JSON.stringify(error.toJSON());
      expect(serialized).not.toContain('Priya');
      expect(serialized).not.toContain('Raghunathan');
      expect(error.match).toBe('rated ... 8');
    }
  });

  it('throws for every must-reject case and for none of the must-pass ones', () => {
    for (const { summary } of MUST_REJECT) {
      expect(() => assertSummaryIsProseOnly(summary), summary).toThrow(SummaryContainsScoreError);
    }
    for (const { summary } of MUST_PASS) {
      expect(() => assertSummaryIsProseOnly(summary), summary).not.toThrow();
    }
  });
});
