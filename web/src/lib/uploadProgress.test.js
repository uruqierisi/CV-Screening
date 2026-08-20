import { describe, expect, test } from 'vitest';
import { allocateProgress, checkFiles } from './uploadProgress.js';

const LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxBatchFiles: 50,
  acceptedMimeTypes: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ],
};

const FILES = [
  { name: 'first.pdf', size: 2000 },
  { name: 'second.pdf', size: 4000 },
  { name: 'third.pdf', size: 1000 },
];

describe('allocateProgress', () => {
  test('nothing sent means everything is waiting', () => {
    expect(allocateProgress(FILES, 0).map((file) => file.state)).toEqual([
      'waiting',
      'waiting',
      'waiting',
    ]);
  });

  test('bytes fill the files in the order they were appended', () => {
    const progress = allocateProgress(FILES, 3000);

    expect(progress[0]).toMatchObject({ sent: 2000, percent: 100, state: 'sent' });
    expect(progress[1]).toMatchObject({ sent: 1000, percent: 25, state: 'sending' });
    expect(progress[2]).toMatchObject({ sent: 0, percent: 0, state: 'waiting' });
  });

  test('the whole body sent means every file is sent', () => {
    expect(allocateProgress(FILES, 7000).every((file) => file.state === 'sent')).toBe(true);
  });

  test('boundary bytes push loaded past the file total without overflowing a file', () => {
    // `event.total` counts the multipart boundaries and part headers, so the
    // final `loaded` is larger than the sum of the file sizes. No file may
    // report more than its own size, and none may exceed 100%.
    const progress = allocateProgress(FILES, 7000 + 600);

    expect(progress.map((file) => file.sent)).toEqual([2000, 4000, 1000]);
    expect(progress.every((file) => file.percent === 100)).toBe(true);
  });

  test('a zero-byte file is complete rather than dividing by zero', () => {
    expect(allocateProgress([{ name: 'empty.txt', size: 0 }], 0)[0]).toMatchObject({
      percent: 100,
      state: 'sent',
    });
  });
});

describe('checkFiles', () => {
  const file = (name, size, type) => ({ name, size, type });

  test('choosing nothing is a problem with a next action', () => {
    expect(checkFiles([], LIMITS)).toHaveLength(1);
  });

  test('accepts an ordinary PDF', () => {
    expect(checkFiles([file('cv.pdf', 2659, 'application/pdf')], LIMITS)).toEqual([]);
  });

  test('names the limit when a file is too large', () => {
    const [problem] = checkFiles([file('scan.pdf', 40 * 1024 * 1024, 'application/pdf')], LIMITS);
    expect(problem.file).toBe('scan.pdf');
    expect(problem.message).toContain('5 MB');
  });

  test('rejects a file count over the batch limit', () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      file(`cv-${index}.pdf`, 1000, 'application/pdf'),
    );
    expect(checkFiles(many, LIMITS)[0].message).toContain('50');
  });

  test('rejects a type the server does not accept', () => {
    const [problem] = checkFiles([file('photo.png', 1000, 'image/png')], LIMITS);
    expect(problem.message).toContain('image/png');
  });

  test('an empty browser-reported type is not evidence of anything', () => {
    // Browsers derive `type` from the extension and often report ''. The server
    // sniffs the actual bytes; guessing here would reject valid files.
    expect(checkFiles([file('cv', 1000, '')], LIMITS)).toEqual([]);
  });

  test('an empty file is refused before it is uploaded', () => {
    expect(checkFiles([file('cv.pdf', 0, 'application/pdf')], LIMITS)[0].message).toContain(
      'empty',
    );
  });
});
