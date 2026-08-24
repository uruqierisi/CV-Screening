/**
 * The two upload endpoints, and the one place `XMLHttpRequest` is used.
 *
 * ## Why not `fetch`
 *
 * `fetch` reports no upload progress. There is a streaming-request path in newer
 * browsers, but it requires HTTP/2, is unsupported in Safari, and gives bytes
 * written to the socket rather than bytes accepted - which is a different number
 * from the one a recruiter watching a 5 MB PDF wants. `XMLHttpRequest.upload`
 * has reported real byte progress in every browser for fifteen years.
 *
 * This is the honest half of plan section 6's two-phase upload: the HTTP upload
 * has **real** progress, and the server pipeline that follows has a **stepper**,
 * because a percentage over an LLM call would be a lie.
 *
 * Errors are translated into the same `ApiError` the `fetch` client throws, so
 * nothing above `src/api/` has to know which transport was used.
 */

import { ApiError } from './client.js';
import { API_BASE, spendingHeaders } from './config.js';

/**
 * @typedef {object} UploadHandle
 * @property {Promise<{ data: any, meta: any }>} result
 * @property {() => void} abort cancels the request in flight
 */

/**
 * Posts one or more CV files to a role.
 *
 * The endpoint is chosen by file count rather than by an argument: one file is
 * the single endpoint, more than one is the batch endpoint. Both create a
 * screening job and both answer the same shape, so the upload screen has exactly
 * one polling shape either way.
 *
 * @param {object} params
 * @param {string} params.roleId
 * @param {File[]} params.files
 * @param {(progress: { loaded: number, total: number }) => void} [params.onProgress]
 * @returns {UploadHandle}
 */
export function uploadCandidates({ roleId, files, onProgress }) {
  const path =
    files.length === 1 ? `/roles/${roleId}/candidates` : `/roles/${roleId}/candidates/batch`;

  const form = new FormData();
  for (const file of files) {
    // The server iterates every file part and ignores the field name; one name
    // repeated is the conventional encoding for a list.
    form.append('files', file, file.name);
  }

  const xhr = new XMLHttpRequest();

  const result = new Promise((resolve, reject) => {
    xhr.open('POST', `${API_BASE}${path}`);

    // After `open` and before `send`, which is the only window where
    // `setRequestHeader` is legal. Uploads are one of the three endpoints the
    // API's spend guard covers.
    for (const [name, value] of Object.entries(spendingHeaders())) {
      xhr.setRequestHeader(name, value);
    }

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        // `lengthComputable` is false for a chunked body; reporting a made-up
        // total there is exactly the fake progress bar section 6 rejects.
        if (event.lengthComputable) {
          onProgress({ loaded: event.loaded, total: event.total });
        }
      });
    }

    xhr.addEventListener('load', () => {
      const payload = parseBody(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ data: payload?.data, meta: payload?.meta });
        return;
      }
      const envelope = payload?.error;
      reject(
        new ApiError({
          code: typeof envelope?.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
          message:
            typeof envelope?.message === 'string' && envelope.message.length > 0
              ? envelope.message
              : `The server answered ${xhr.status} with no message.`,
          status: xhr.status,
          requestId: envelope?.requestId ?? null,
          details: envelope?.details ?? null,
        }),
      );
    });

    xhr.addEventListener('error', () => {
      reject(
        new ApiError({
          code: 'NETWORK_UNREACHABLE',
          message:
            'The upload could not reach the screening API. Check that the server is running, then try again.',
          status: 0,
        }),
      );
    });

    xhr.addEventListener('abort', () => {
      reject(
        new ApiError({
          code: 'UPLOAD_CANCELLED',
          message: 'The upload was cancelled before it finished.',
          status: 0,
        }),
      );
    });

    xhr.send(form);
  });

  return { result, abort: () => xhr.abort() };
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
