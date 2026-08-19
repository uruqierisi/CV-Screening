import Anthropic from '@anthropic-ai/sdk';

/**
 * The injected client every 2b test uses instead of the real one.
 *
 * It is a plain object with a `messages.parse` method, which is the entire
 * interface the agent layer asks for. No module mocking, no `vi.mock`, no
 * interception: the code under test is the code that ships, and the thing it
 * calls is a script the test wrote.
 *
 * One property makes these tests worth more than a stub would be. The fake calls
 * **the real `output_config.format.parse`** - the function `toOutputFormat`
 * built out of the real zod schema - on the exact text the script provides. So a
 * test that says "the model returned this JSON" exercises the real JSON parse,
 * the real schema validation and the real discriminated result, and a test that
 * returns malformed JSON fails for the real reason rather than because a stub
 * was told to say it did.
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
 * @param {ScriptedResponse[] | ((call: number, params: any) => ScriptedResponse)} script
 * @returns {{ messages: { parse: Function }, calls: { params: any, options: any }[] }}
 */
export function fakeAnthropic(script) {
  /** @type {{ params: any, options: any }[]} */
  const calls = [];

  return {
    calls,
    messages: {
      /**
       * @param {any} params
       * @param {any} options
       */
      async parse(params, options) {
        calls.push({ params, options });

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
          parsed_output: null,
        };

        if (step.noText !== true && text !== undefined) {
          message.content = [{ type: 'text', text }];
          message.parsed_output = params.output_config.format.parse(text);
        }

        return message;
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
