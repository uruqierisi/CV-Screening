/**
 * Per-file progress out of one multipart request's byte counter.
 *
 * ## Why this is honest rather than a guess
 *
 * A multipart body is the parts concatenated **in the order they were appended**,
 * each preceded by a boundary and its headers. So a cumulative `loaded` figure
 * is a position in that stream, and the file it lands in is a fact, not an
 * estimate: at 3.2 MB sent of a 2 MB file followed by a 4 MB file, the first file
 * is complete and the second is 1.2 MB in.
 *
 * The inaccuracy is the boundary and header bytes - roughly 150 to 250 per part,
 * against files measured in megabytes - which makes each file appear to complete
 * a fraction early. That is a rounding error in the third decimal place of a
 * progress bar, and it is recorded here rather than hidden.
 *
 * ## Why not one request per file
 *
 * Uploading each file separately would give a byte counter per file with no
 * arithmetic at all. It was rejected: it turns one screening job into N, so the
 * batch's all-or-nothing rejection of a bad file (plan section 3) is lost, it
 * multiplies the rate-limited requests by the file count, and it leaves a
 * half-failed upload with some files accepted and some not - which is a state
 * this screen would then have to explain.
 */

/**
 * @typedef {object} FileProgress
 * @property {string} name
 * @property {number} size
 * @property {number} sent bytes of this file believed to have been sent
 * @property {number} percent 0..100, integer
 * @property {'waiting'|'sending'|'sent'} state
 */

/**
 * @param {Array<{ name: string, size: number }>} files in the order they were appended
 * @param {number} loaded cumulative bytes reported by the request
 * @returns {FileProgress[]}
 */
export function allocateProgress(files, loaded) {
  let remaining = Math.max(0, loaded);

  return files.map((file) => {
    const sent = Math.min(file.size, remaining);
    remaining -= sent;

    const percent = file.size === 0 ? 100 : Math.floor((sent / file.size) * 100);
    const state = sent >= file.size ? 'sent' : sent > 0 ? 'sending' : 'waiting';

    return { name: file.name, size: file.size, sent, percent, state };
  });
}

/**
 * Client-side file checks, against the limits `/config` publishes.
 *
 * The server checks all of this again - it sniffs the bytes rather than
 * trusting a browser-reported MIME type, which this cannot do. The point of
 * checking here is that a recruiter who picked a 40 MB scan finds out before
 * spending two minutes uploading it, and the message names the limit.
 *
 * @param {File[]} files
 * @param {{ maxFileBytes: number, maxBatchFiles: number, acceptedMimeTypes: string[] }} limits
 * @returns {Array<{ file: string, message: string }>}
 */
export function checkFiles(files, limits) {
  /** @type {Array<{ file: string, message: string }>} */
  const problems = [];

  if (files.length === 0) {
    problems.push({ file: '', message: 'Choose at least one CV to upload.' });
    return problems;
  }

  if (files.length > limits.maxBatchFiles) {
    problems.push({
      file: '',
      message: `This server accepts ${limits.maxBatchFiles} files per upload. You chose ${files.length}.`,
    });
  }

  for (const file of files) {
    if (file.size > limits.maxFileBytes) {
      problems.push({
        file: file.name,
        message: `is larger than the ${formatLimit(limits.maxFileBytes)} limit.`,
      });
    }
    if (file.size === 0) {
      problems.push({ file: file.name, message: 'is empty.' });
    }
    // A browser reports type from the file extension, so an empty string is
    // common and is not evidence of anything. Only a positively wrong type is
    // rejected here; the server sniffs the actual bytes.
    if (file.type !== '' && !limits.acceptedMimeTypes.includes(file.type)) {
      problems.push({
        file: file.name,
        message: `is a ${file.type}. This server accepts PDF, DOCX and plain text.`,
      });
    }
  }

  return problems;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatLimit(bytes) {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}
