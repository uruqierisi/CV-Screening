import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  messageText,
  parseJsonResponse,
  parseMessageJson,
  stripCodeFences,
} from '../../src/agents/client/json-response.js';

/**
 * The parser that replaced the decoding grammar on the extraction call.
 *
 * Every case here is a shape a model actually produces when it is asked for JSON
 * in prose rather than constrained to it. The division of responsibility being
 * tested is the important part:
 *
 * - a **fence** is a wrapper with no content, so it is removed;
 * - a **preamble** is the model doing something else, so it is not repaired - it
 *   fails as `invalid_json`, takes the one semantic retry with the correction
 *   attached, and is visible in the logs.
 *
 * Quietly hunting for the first `{` would rescue today's response and hide a
 * drifting model, which is the trade this file exists to refuse.
 */

const ANSWER = z.object({ answer: z.string() }).strict();

/** @param {string} text */
const textMessage = (text) => ({ content: [{ type: 'text', text }] });

describe('stripping a code fence', () => {
  it.each([
    ['a json-tagged fence', '```json\n{"answer":"yes"}\n```'],
    ['an untagged fence', '```\n{"answer":"yes"}\n```'],
    ['an uppercase tag', '```JSON\n{"answer":"yes"}\n```'],
    ['leading and trailing whitespace around it', '\n\n```json\n{"answer":"yes"}\n```\n\n'],
    ['trailing spaces on the fence lines', '```json  \n{"answer":"yes"}\n  ```  '],
    ['a fence that was never closed', '```json\n{"answer":"yes"}'],
    ['a single-line fence', '```json\n{"answer":"yes"}```'],
  ])('unwraps %s', (_what, text) => {
    expect(JSON.parse(stripCodeFences(text))).toEqual({ answer: 'yes' });
  });

  it('leaves a bare JSON object exactly as it was', () => {
    // The overwhelmingly common case. Byte-identical, not merely equivalent:
    // this function must not be able to change a well-formed response.
    const text = '{"answer":"yes"}';
    expect(stripCodeFences(text)).toBe(text);
  });

  it('leaves prose alone, fences and all, when the fence is not at the start', () => {
    // A preamble is not a wrapper. Left intact, it fails as `invalid_json` and
    // the retry tells the model exactly that.
    const preamble = 'Sure! Here is the profile:\n```json\n{"answer":"yes"}\n```';
    expect(stripCodeFences(preamble)).toBe(preamble);
    expect(parseJsonResponse(ANSWER, stripCodeFences(preamble))).toEqual({
      ok: false,
      kind: 'invalid_json',
    });
  });

  it('does not mistake a fence inside a string value for a wrapper', () => {
    // A CV can contain three backticks, and so therefore can an evidence quote.
    const text = '{"answer":"the readme says ```bash"}';
    expect(JSON.parse(stripCodeFences(text)).answer).toBe('the readme says ```bash');
  });
});

describe('finding the text of a response', () => {
  it('joins the text blocks and ignores everything else', () => {
    // Thinking blocks sit in the same array. `content[0]` would read one of
    // those on any call that produces them.
    const message = {
      content: [
        { type: 'thinking', thinking: 'the CV lists two roles' },
        { type: 'text', text: '{"answer":' },
        { type: 'text', text: '"yes"}' },
      ],
    };

    expect(messageText(message)).toBe('{"answer":"yes"}');
  });

  it.each([
    ['an empty content array', { content: [] }],
    ['a response made entirely of thinking', { content: [{ type: 'thinking' }] }],
    ['an empty text block', { content: [{ type: 'text', text: '' }] }],
    ['a text block whose text is not a string', { content: [{ type: 'text', text: 42 }] }],
    ['no content field at all', {}],
    ['a content field that is not an array', { content: 'oops' }],
  ])('reports %s as nothing to parse', (_what, message) => {
    // Null here becomes `no_output` upstream, which is the same branch a null
    // `parsed_output` takes on the structured path. One taxonomy, two paths.
    expect(messageText(message)).toBeNull();
    expect(parseMessageJson(ANSWER, message)).toBeNull();
  });
});

describe('parsing and validating', () => {
  it('returns the validated data, not the raw JSON', () => {
    const result = parseJsonResponse(ANSWER, '{"answer":"yes"}');
    expect(result).toEqual({ ok: true, data: { answer: 'yes' } });
  });

  it('reports malformed JSON as its own kind, because the retry differs', () => {
    expect(parseJsonResponse(ANSWER, 'I could not find a CV in that.')).toEqual({
      ok: false,
      kind: 'invalid_json',
    });
  });

  it('reports a schema mismatch with the path, the code and the message', () => {
    const result = parseJsonResponse(ANSWER, '{"answer":7}');

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('schema_mismatch');
    expect(result.issues).toEqual([
      { path: 'answer', code: 'invalid_type', message: expect.stringContaining('Expected') },
    ]);
  });

  it('names a nested path the way a retry notice can print it', () => {
    const nested = z.object({ skills: z.array(z.object({ name: z.string() })) }).strict();
    const result = parseJsonResponse(nested, '{"skills":[{"name":1}]}');

    expect(result.issues[0].path).toBe('skills.0.name');
  });

  it('rejects an unknown key rather than stripping it', () => {
    // `.strict()` is what stops a model quietly inventing a field - most
    // importantly a score. Without a grammar it can now try.
    const result = parseJsonResponse(ANSWER, '{"answer":"yes","overallScore":88}');

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('schema_mismatch');
  });

  it('parses a fenced response end to end, which is the whole defensive path', () => {
    expect(parseMessageJson(ANSWER, textMessage('```json\n{"answer":"yes"}\n```'))).toEqual({
      ok: true,
      data: { answer: 'yes' },
    });
  });
});
