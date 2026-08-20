/**
 * The fixture generator: real PDF, DOCX and TXT files, built from code.
 *
 * **Why generated rather than checked in as opaque binaries.** A committed
 * `two-column.pdf` that somebody produced in Word once is a file nobody can
 * change, review or explain - the interesting property of the two-column
 * fixture is *the order its content stream emits the columns in*, and that is
 * invisible in a binary and obvious in the array on line 200 of this file. The
 * files are still committed, because the parser must be exercised against real
 * bytes; this is what those bytes are made of.
 *
 * Everything here is deterministic. No dates, no random ids, no compression
 * levels left to a default - `generate.js` writes the same bytes on every
 * machine, and `fixtures.test.js` asserts it.
 *
 * The PDFs are hand-assembled rather than produced by a library, and that is
 * the point twice over: no fixture dependency to keep current, and total control
 * over the content stream, which is the only way to build the row-major
 * two-column case the parser is being interrogated about.
 */

import { crc32, deflateRawSync } from 'node:zlib';

import { ZIP_METHODS } from '../../../src/extraction/zip.js';

/* -------------------------------------------------------------------------- */
/* PDF                                                                        */
/* -------------------------------------------------------------------------- */

/** US Letter, in PDF points. Any size would do; a familiar one reads better. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * Escapes a string for a PDF literal string, where `(`, `)` and `\` are
 * structural.
 *
 * @param {string} value
 * @returns {string}
 */
function escapePdfString(value) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * One piece of text placed at an absolute position.
 *
 * @typedef {object} PdfTextRun
 * @property {number} x points from the left edge
 * @property {number} y points from the *bottom* edge - PDF's y axis points up
 * @property {number} size font size in points
 * @property {string} text
 */

/**
 * Builds a page's content stream.
 *
 * Every run gets its own `BT`/`ET` block with an absolute text matrix, rather
 * than the relative `Td` offsets a real producer would use. Absolute positioning
 * is what makes the emission order independent of the layout: the same three
 * lines can be emitted column-major or row-major and land in identical places
 * on the page, which is exactly the experiment `two-column-pdf.test.js` runs.
 *
 * @param {readonly PdfTextRun[]} runs in the order they should be emitted
 * @returns {string}
 */
function buildContentStream(runs) {
  return runs
    .map(
      (run) =>
        `BT /F1 ${run.size} Tf 1 0 0 1 ${run.x} ${run.y} Tm (${escapePdfString(run.text)}) Tj ET`,
    )
    .join('\n');
}

/**
 * Assembles a complete PDF from a list of already-serialized objects.
 *
 * Handles the two bookkeeping details that make a PDF valid: the cross-reference
 * table, which is a byte offset per object, and `startxref`, which is the byte
 * offset of that table. Both are computed from the output as it is built, in
 * `latin1` so that one character is one byte.
 *
 * @param {readonly string[]} objects 1-indexed; index 0 is unused
 * @returns {Buffer}
 */
function assemblePdf(objects) {
  let out = '%PDF-1.4\n';
  /** @type {number[]} */
  const offsets = [];

  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(out, 'latin1');
  const size = objects.length;

  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

/**
 * Builds a text PDF.
 *
 * @param {readonly (readonly PdfTextRun[])[]} pages one array of runs per page
 * @returns {Buffer}
 */
export function buildTextPdf(pages) {
  /** @type {string[]} */
  const objects = [];
  const pageObjectIds = pages.map((_, index) => 3 + index * 2);
  const contentObjectIds = pages.map((_, index) => 4 + index * 2);
  const fontId = 3 + pages.length * 2;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(' ')}] /Count ${pages.length} >>`;

  pages.forEach((runs, index) => {
    objects[pageObjectIds[index]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`;

    const stream = buildContentStream(runs);
    objects[contentObjectIds[index]] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  // Helvetica: one of the fourteen standard fonts, so nothing has to be
  // embedded and the fixture stays a few hundred bytes. WinAnsiEncoding so the
  // character codes in the content stream mean what they look like.
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  return assemblePdf(objects);
}

/**
 * Builds a PDF whose only content is a raster image - no fonts, no text
 * operators, nothing to extract. What a flatbed scanner produces.
 *
 * The image is a 1-bit DeviceGray bitmap drawn as horizontal bars of varying
 * length, which is what a page of text looks like from far enough away. It is
 * stored uncompressed: 15 bytes per row over 160 rows is 2,400 bytes, which is
 * smaller than the problem of making a fixture's bytes depend on the zlib
 * version that happened to be installed.
 *
 * @returns {Buffer}
 */
export function buildScannedPdf() {
  const imageWidth = 120;
  const imageHeight = 160;
  const bytesPerRow = imageWidth / 8;
  const raster = Buffer.alloc(bytesPerRow * imageHeight, 0xff);

  // A deterministic pattern of "text lines": eight bars, every other block of
  // rows, each a different length. No randomness - the same bytes every time.
  for (let row = 0; row < imageHeight; row += 1) {
    const block = Math.floor(row / 10);
    const isTextRow = block % 2 === 0 && row % 10 < 6;
    if (!isTextRow) {
      continue;
    }
    const barBytes = 4 + (block % 5) * 2;
    for (let column = 0; column < barBytes && column < bytesPerRow; column += 1) {
      // 0 is black in DeviceGray.
      raster[row * bytesPerRow + column] = 0x00;
    }
  }

  const drawnWidth = 480;
  const drawnHeight = 640;
  const content =
    `q\n${drawnWidth} 0 0 ${drawnHeight} 66 76 cm\n/Im0 Do\nQ`;

  /** @type {string[]} */
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
    '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>';
  objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objects[5] =
    `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} ` +
    `/ColorSpace /DeviceGray /BitsPerComponent 1 /Length ${raster.length} >>\n` +
    `stream\n${raster.toString('latin1')}\nendstream`;

  return assemblePdf(objects);
}

/* -------------------------------------------------------------------------- */
/* DOCX                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A fixed MS-DOS timestamp for every entry: 1980-01-01 00:00:00, the earliest
 * the format can represent. Real archives carry the moment they were written,
 * which would make these fixtures differ on every regeneration - and a fixture
 * that changes when nothing changed is a fixture nobody trusts.
 */
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 0x0021;

/**
 * @typedef {object} ZipInput
 * @property {string} name
 * @property {string} content
 * @property {number} [method] one of {@link ZIP_METHODS}; defaults to deflate
 */

/**
 * Writes a ZIP archive.
 *
 * Deliberately supports both stored and deflated entries, because the reader in
 * `src/extraction/zip.js` supports both and a fixture that only ever exercised
 * one would leave the other untested against a real archive.
 *
 * @param {readonly ZipInput[]} files
 * @returns {Buffer}
 */
export function buildZip(files) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const file of files) {
    const method = file.method ?? ZIP_METHODS.DEFLATE;
    const raw = Buffer.from(file.content, 'utf8');
    // Level 9 named explicitly: the default is a moving target across Node
    // versions, and this is a fixture whose bytes are asserted.
    const stored = method === ZIP_METHODS.STORED ? raw : deflateRawSync(raw, { level: 9 });
    const name = Buffer.from(file.name, 'utf8');
    const checksum = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed: 2.0
    localHeader.writeUInt16LE(0, 6); // no flags: not encrypted, sizes are here
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DOS_EPOCH_TIME, 10);
    localHeader.writeUInt16LE(DOS_EPOCH_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(stored.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28); // no extra field

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DOS_EPOCH_TIME, 12);
    centralHeader.writeUInt16LE(DOS_EPOCH_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(stored.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42);

    chunks.push(localHeader, name, stored);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + stored.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** The OOXML package declaration. Its presence is what makes a ZIP a DOCX. */
const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

/** The package relationship pointing at the main document part. */
const PACKAGE_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

/**
 * Wraps paragraphs in the WordprocessingML a real Word file uses.
 *
 * @param {readonly string[]} paragraphs already XML-escaped, or containing
 *   deliberate markup for a test that wants it
 * @returns {string}
 */
export function buildWordDocumentXml(paragraphs) {
  const body = paragraphs
    .map((paragraph) =>
      paragraph.length === 0
        ? '<w:p/>'
        : `<w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p>`,
    )
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>` +
    '</w:document>'
  );
}

/**
 * Builds a complete, openable DOCX.
 *
 * Three parts, which is the minimum a conforming package needs: the content
 * type declaration, the package relationships, and the main document.
 *
 * @param {readonly string[]} paragraphs
 * @param {object} [options]
 * @param {number} [options.method] compression for the document part
 * @returns {Buffer}
 */
export function buildDocx(paragraphs, { method = ZIP_METHODS.DEFLATE } = {}) {
  return buildZip([
    // Stored, like Word writes it: the content-type part is short enough that
    // deflating it makes it bigger.
    { name: '[Content_Types].xml', content: CONTENT_TYPES_XML, method: ZIP_METHODS.STORED },
    { name: '_rels/.rels', content: PACKAGE_RELS_XML, method: ZIP_METHODS.STORED },
    { name: 'word/document.xml', content: buildWordDocumentXml(paragraphs), method },
  ]);
}

/* -------------------------------------------------------------------------- */
/* The five committed fixtures                                                */
/* -------------------------------------------------------------------------- */

/**
 * A conventional single-column CV. Two pages, so `pageCount` in the result is
 * something other than 1 and the characters-per-page arithmetic is exercised
 * against a real multi-page document.
 */
export const CLEAN_PDF_PAGES = Object.freeze([
  Object.freeze([
    { x: 72, y: 720, size: 18, text: 'Priya Ramanathan' },
    { x: 72, y: 700, size: 10, text: 'priya.ramanathan@example.com | +44 20 7946 0102 | London, UK' },
    { x: 72, y: 664, size: 13, text: 'PROFILE' },
    { x: 72, y: 646, size: 10, text: 'Backend engineer with nine years building payment and identity' },
    { x: 72, y: 632, size: 10, text: 'systems in Node.js and PostgreSQL for regulated companies.' },
    { x: 72, y: 596, size: 13, text: 'EXPERIENCE' },
    { x: 72, y: 578, size: 11, text: 'Senior Backend Engineer, Northwind Payments' },
    { x: 72, y: 564, size: 10, text: 'January 2019 - present, London' },
    { x: 86, y: 546, size: 10, text: 'Led the migration of the ledger service to PostgreSQL 14,' },
    { x: 86, y: 532, size: 10, text: 'cutting settlement reconciliation from six hours to eleven minutes.' },
    { x: 86, y: 518, size: 10, text: 'Designed the idempotency layer behind the public payments API.' },
    { x: 72, y: 490, size: 11, text: 'Backend Engineer, Griffin Health' },
    { x: 72, y: 476, size: 10, text: 'March 2016 - December 2018, Manchester' },
    { x: 86, y: 458, size: 10, text: 'Built the appointment scheduling service used by 40 clinics.' },
    { x: 86, y: 444, size: 10, text: 'Introduced contract testing across six internal services.' },
  ]),
  Object.freeze([
    { x: 72, y: 720, size: 13, text: 'EDUCATION' },
    { x: 72, y: 702, size: 11, text: 'BSc Computer Science, University of Manchester' },
    { x: 72, y: 688, size: 10, text: '2012 - 2015, First Class Honours' },
    { x: 72, y: 652, size: 13, text: 'SKILLS' },
    { x: 72, y: 634, size: 10, text: 'Node.js, TypeScript, PostgreSQL, Redis, Docker, AWS, Terraform' },
    { x: 72, y: 620, size: 10, text: 'Distributed systems, API design, observability, incident response' },
    { x: 72, y: 584, size: 13, text: 'CERTIFICATIONS' },
    { x: 72, y: 566, size: 10, text: 'AWS Certified Solutions Architect - Associate, 2021' },
  ]),
]);

/**
 * The two-column fixture, and the reason it is written this way.
 *
 * The runs are emitted **row by row**: the left column's first line, then the
 * right column's first line, then the left column's second line, and so on.
 * That is what a CV built on a two-column *table* produces, which is one of the
 * most common templates there is - and it is the worst realistic case for a
 * text extractor, because the content stream's order is not the reading order.
 *
 * The choice is deliberate and it is the experiment. A producer that emits the
 * same layout **column by column** - Word's column sections, InDesign frames,
 * most LaTeX classes - extracts perfectly, and `two-column-pdf.test.js` builds
 * exactly that variant in memory from these same runs to prove the difference is
 * the emission order rather than the layout.
 */
export const TWO_COLUMN_PDF_ROWS = Object.freeze([
  Object.freeze([
    { left: { size: 13, text: 'EXPERIENCE' }, right: { size: 13, text: 'SKILLS' } },
    { left: { size: 11, text: 'Senior Backend Engineer' }, right: { size: 10, text: 'Node.js' } },
    { left: { size: 10, text: 'Northwind Payments' }, right: { size: 10, text: 'PostgreSQL' } },
    { left: { size: 10, text: 'January 2019 - present' }, right: { size: 10, text: 'Redis' } },
    { left: { size: 10, text: 'Led the ledger migration' }, right: { size: 10, text: 'Docker' } },
    { left: { size: 11, text: 'Backend Engineer' }, right: { size: 13, text: 'EDUCATION' } },
    { left: { size: 10, text: 'Griffin Health' }, right: { size: 10, text: 'BSc Computer Science' } },
    { left: { size: 10, text: 'March 2016 - December 2018' }, right: { size: 10, text: 'Manchester, 2015' } },
    { left: { size: 10, text: 'Built appointment scheduling' }, right: { size: 13, text: 'CONTACT' } },
    { left: { size: 10, text: 'for forty clinics' }, right: { size: 10, text: 'priya@example.com' } },
  ]),
]);

/** Where the two columns sit on the page. */
const LEFT_COLUMN_X = 60;
const RIGHT_COLUMN_X = 360;
const FIRST_ROW_Y = 700;
const ROW_SPACING = 22;

/**
 * Flattens the two-column rows into PDF text runs.
 *
 * The positions do not depend on the order, only on the row index - so the two
 * orders below place identical ink on identical coordinates and differ in
 * nothing but the sequence of operators in the content stream.
 *
 * @param {'row-major' | 'column-major'} order
 * @returns {PdfTextRun[][]}
 */
export function buildTwoColumnRuns(order) {
  return TWO_COLUMN_PDF_ROWS.map((rows) => {
    const left = rows.map((row, index) => ({
      x: LEFT_COLUMN_X,
      y: FIRST_ROW_Y - index * ROW_SPACING,
      size: row.left.size,
      text: row.left.text,
    }));
    const right = rows.map((row, index) => ({
      x: RIGHT_COLUMN_X,
      y: FIRST_ROW_Y - index * ROW_SPACING,
      size: row.right.size,
      text: row.right.text,
    }));

    if (order === 'column-major') {
      return [...left, ...right];
    }
    return rows.flatMap((_, index) => [left[index], right[index]]);
  });
}

/** The DOCX fixture's paragraphs. */
export const DOCX_PARAGRAPHS = Object.freeze([
  'Marcus Adeyemi',
  'marcus.adeyemi@example.com | +44 161 496 0250 | Manchester, UK',
  '',
  'PROFILE',
  'Backend engineer with seven years in Node.js, focused on data pipelines and the boring reliability work that keeps them up.',
  '',
  'EXPERIENCE',
  'Lead Engineer, Halcyon Data &amp; Analytics',
  'June 2020 - present',
  'Rebuilt the ingestion pipeline to process 40 million events a day at a third of the previous cost.',
  'Owns the on-call rotation and the incident review process for a team of nine.',
  '',
  'Backend Engineer, Tessellate Ltd',
  'September 2017 - May 2020',
  'Delivered the customer-facing reporting API used by 300 accounts.',
  '',
  'EDUCATION',
  'MEng Software Engineering, University of Leeds, 2013 - 2017',
  '',
  'SKILLS',
  'Node.js, PostgreSQL, Kafka, Kubernetes, Terraform, Python',
]);

/** The TXT fixture. CRLF line endings, because a real one from Windows has them. */
export const TXT_CONTENT = [
  'AISHA KHAN',
  'aisha.khan@example.com | +44 131 496 0900 | Edinburgh, UK',
  '',
  'PROFILE',
  'Backend engineer, six years, mostly Node.js and PostgreSQL. Comfortable',
  'owning a service end to end, from the schema to the dashboard nobody',
  'wanted to build.',
  '',
  'EXPERIENCE',
  'Senior Engineer, Kelpie Logistics -- February 2021 to present',
  '  Rewrote the route optimisation service; cut planning time by 70%.',
  '  Introduced database migrations to a team that had none.',
  '',
  'Engineer, Thistle Software -- August 2018 to January 2021',
  '  Maintained the billing service and its integration with Stripe.',
  '',
  'EDUCATION',
  'BSc Computing Science, University of Edinburgh, 2015 - 2018',
  '',
  'SKILLS',
  'Node.js, PostgreSQL, Redis, AWS, Docker, CI/CD',
  '',
].join('\r\n');

/**
 * Every committed fixture, built. One function so `generate.js` and
 * `fixtures.test.js` cannot disagree about what should be on disk.
 *
 * @returns {Record<string, Buffer>} filename to bytes
 */
export function buildAllFixtures() {
  return {
    'clean.pdf': buildTextPdf(CLEAN_PDF_PAGES),
    'two-column.pdf': buildTextPdf(buildTwoColumnRuns('row-major')),
    'scanned.pdf': buildScannedPdf(),
    'cv.docx': buildDocx(DOCX_PARAGRAPHS),
    'cv.txt': Buffer.from(TXT_CONTENT, 'utf8'),
  };
}
