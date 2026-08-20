import Anthropic from '@anthropic-ai/sdk';

/**
 * The injected client every 2b test uses instead of the real one.
 *
 * It is a plain object with `messages.parse` and `messages.create` methods,
 * which is the entire interface the agent layer asks for. No module mocking, no
 * `vi.mock`, no interception: the code under test is the code that ships, and
 * the thing it calls is a script the test wrote.
 *
 * **Two methods, because the two calls ask for their JSON differently.**
 * Evaluation sends `output_config.format` and goes through `messages.parse`;
 * extraction sends no schema at all and goes through `messages.create` (plan
 * section 5.2). The fake mirrors that split rather than papering over it, so a
 * call site that reached for the wrong method would fail here instead of in
 * production.
 *
 * One property makes these tests worth more than a stub would be: **whichever
 * method is called, the real parsing runs.**
 *
 * - `parse` calls the real `output_config.format.parse` - the function
 *   `toOutputFormat` built out of the real zod schema - exactly as the SDK does.
 * - `create` does no parsing at all, exactly as the SDK does, which leaves
 *   `client/json-response.js` to find the text block, strip a fence and validate
 *   against the schema for real.
 *
 * So a test that says "the model returned this JSON" exercises the real JSON
 * parse, the real schema validation and the real discriminated result, and a
 * test that returns malformed JSON fails for the real reason rather than because
 * a stub was told to say it did.
 *
 * Both methods share one call log and one script cursor, so a test that scripts
 * `[extraction, evaluation]` reads in pipeline order regardless of which method
 * each stage used.
 */

/**
 * @typedef {object} ScriptedResponse
 * @property {string} [text] the raw text block the model "returned"
 * @property {unknown} [json] convenience: serialized to `text` for you
 * @property {boolean} [noText] respond with no text block at all
 * @property {string} [stopReason] defaults to `end_turn`
 * @property {{ category: string | null, explanation?: string | null, type?: string }} [stopDetails]
 *   populated by the API only when `stopReason` is `refusal`
 * @property {{ input_tokens: number, output_tokens: number }} [usage]
 * @property {Error} [throws] thrown instead of responding, to drive the transport paths
 * @property {boolean} [hangs] never answers; rejects when the request is aborted
 */

/**
 * @typedef {object} FakeAnthropic
 * @property {{ parse: Function, create: Function }} messages
 * @property {{ params: any, options: any, method: 'parse' | 'create' }[]} calls
 */

/**
 * @param {ScriptedResponse[] | ((call: number, params: any) => ScriptedResponse)} script
 * @returns {FakeAnthropic}
 */
export function fakeAnthropic(script) {
  /** @type {{ params: any, options: any, method: 'parse' | 'create' }[]} */
  const calls = [];

  /**
   * Everything both methods do identically, which is everything except what
   * lands in `parsed_output`.
   *
   * @param {'parse' | 'create'} method
   * @param {any} params
   * @param {any} options
   * @returns {Promise<any>}
   */
  async function respond(method, params, options) {
    calls.push({ params, options, method });

    const step =
      typeof script === 'function' ? script(calls.length, params) : script[calls.length - 1];

    if (step === undefined) {
      throw new Error(
        `fake client: the test scripted ${Array.isArray(script) ? script.length : '?'} response(s) but the code made call ${calls.length}`,
      );
    }

    if (step.throws !== undefined) {
      throw step.throws;
    }

    if (step.hangs === true) {
      // Never answers, and honours the abort signal exactly as the SDK does:
      // an aborted request rejects with `APIUserAbortError`. This is what
      // lets the deadline be tested without a real socket and without
      // waiting 240 seconds for it.
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Anthropic.APIUserAbortError()),
          { once: true },
        );
      });
    }

    const text = step.json === undefined ? step.text : JSON.stringify(step.json);

    /** @type {any} */
    const message = {
      id: `msg_fake_${calls.length}`,
      model: params.model,
      role: 'assistant',
      type: 'message',
      // `=== undefined` rather than `??`, so a test can script an
      // explicitly null stop reason or usage block - both of which the API can
      // return and both of which the code has to handle.
      stop_reason: step.stopReason === undefined ? 'end_turn' : step.stopReason,
      // The real API populates this only on a refusal, and the code under
      // test is required to read it only there. The fake mirrors that so a
      // regression is visible rather than accidentally harmless.
      stop_details: step.stopReason === 'refusal' ? (step.stopDetails ?? null) : null,
      usage: step.usage === undefined ? { input_tokens: 1234, output_tokens: 567 } : step.usage,
      content: [],
    };

    if (method === 'parse') {
      // Only the structured path has this field at all. A `create` response
      // carrying a null `parsed_output` would let a bug that reads the wrong
      // field pass as a `no_output` retry instead of failing.
      message.parsed_output = null;
    }

    if (step.noText !== true && text !== undefined) {
      message.content = [{ type: 'text', text }];
      if (method === 'parse') {
        message.parsed_output = params.output_config.format.parse(text);
      }
    }

    return message;
  }

  return {
    calls,
    messages: {
      /**
       * The structured path. Requires `output_config.format`, because the SDK
       * method that runs a format's parser cannot be called without one.
       *
       * @param {any} params
       * @param {any} options
       */
      parse(params, options) {
        if (params?.output_config?.format === undefined) {
          return Promise.reject(
            new Error('fake client: messages.parse was called without output_config.format'),
          );
        }
        return respond('parse', params, options);
      },

      /**
       * The unstructured path: text in the body, nothing parsed for you.
       *
       * A format here would mean a call site asked for a grammar and then took
       * the method that ignores it, which is a silent downgrade rather than a
       * visible one.
       *
       * @param {any} params
       * @param {any} options
       */
      create(params, options) {
        if (params?.output_config?.format !== undefined) {
          return Promise.reject(
            new Error('fake client: messages.create was called with output_config.format'),
          );
        }
        return respond('create', params, options);
      },
    },
  };
}

/**
 * A script that answers every call the same way. For tests about something other
 * than the response.
 *
 * @param {ScriptedResponse} response
 * @returns {(call: number, params: any) => ScriptedResponse}
 */
export function always(response) {
  return () => response;
}
