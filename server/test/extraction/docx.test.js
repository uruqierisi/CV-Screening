import { describe, expect, it } from 'vitest';

import { extractLinesFromWordXml, parseDocx } from '../../src/extraction/parsers/docx.js';
import { ZIP_METHODS, findZipEntry, readZipDirectory } from '../../src/extraction/zip.js';
import { buildDocx, buildWordDocumentXml } from './fixtures/build-documents.js';

/**
 * WordprocessingML to text.
 *
 * The scan is exercised with XML strings, because that is what the decisions are
 * about; `parseDocx` is exercised with real archives, because that is what the
 * container is about.
 */

describe('extractLinesFromWordXml', () => {
  it('reads one line per paragraph', () => {
    const xml = buildWordDocumentXml(['Priya Ramanathan', 'London, UK']);

    expect(extractLinesFromWordXml(xml)).toEqual(['Priya Ramanathan', 'London, UK', '']);
  });

  it('joins the runs Word splits a sentence into', () => {
    // Word breaks a paragraph into runs at every formatting change, so a line
    // with one bold word arrives as three runs. A reader that emitted one line
    // per run would shred every CV that uses bold for job titles.
    const xml =
      '<w:p><w:r><w:t xml:space="preserve">Senior </w:t></w:r>' +
      '<w:r><w:t>Backend</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve"> Engineer</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml)[0]).toBe('Senior Backend Engineer');
  });

  it('respects xml:space="preserve", which is how Word keeps a leading space', () => {
    const xml = '<w:p><w:r><w:t xml:space="preserve">Node.js, </w:t></w:r><w:r><w:t>Redis</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml)[0]).toBe('Node.js, Redis');
  });

  it('turns a tab into a space rather than a tab', () => {
    // Tabs are used for alignment far more often than for indentation, and
    // "Senior Engineer <tab> 2019" reads better as a space to everything
    // downstream.
    const xml = '<w:p><w:r><w:t>Senior Engineer</w:t><w:tab/><w:t>2019 - 2024</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml)[0]).toBe('Senior Engineer 2019 - 2024');
  });

  it('breaks a line at an explicit break inside a paragraph', () => {
    const xml = '<w:p><w:r><w:t>Northwind Payments</w:t><w:br/><w:t>London</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml).slice(0, 2)).toEqual(['Northwind Payments', 'London']);
  });

  it('handles a page break, which carries an attribute the naive pattern would miss', () => {
    const xml =
      '<w:p><w:r><w:t>EXPERIENCE</w:t><w:br w:type="page"/><w:t>EDUCATION</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml).slice(0, 2)).toEqual(['EXPERIENCE', 'EDUCATION']);
  });

  it('treats a carriage-return element as a break too', () => {
    const xml = '<w:p><w:r><w:t>Line one</w:t><w:cr/><w:t>Line two</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml).slice(0, 2)).toEqual(['Line one', 'Line two']);
  });

  it('emits an empty line for the empty paragraph Word writes for a press of Enter', () => {
    const xml = '<w:p><w:r><w:t>EXPERIENCE</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>Northwind</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml)).toEqual(['EXPERIENCE', '', 'Northwind', '']);
  });

  it('consumes a self-closing empty text run without emitting a line for it', () => {
    const xml = '<w:p><w:r><w:t/><w:t>Priya</w:t></w:r></w:p>';

    expect(extractLinesFromWordXml(xml)).toEqual(['Priya', '']);
  });

  it('decodes the five predefined XML entities', () => {
    const xml = buildWordDocumentXml(['Halcyon Data &amp; Analytics &lt;R&amp;D&gt; &quot;team&quot; &apos;A&apos;']);

    expect(extractLinesFromWordXml(xml)[0]).toBe('Halcyon Data & Analytics <R&D> "team" \'A\'');
  });

  it('decodes decimal and hexadecimal character references', () => {
    const xml = buildWordDocumentXml(['caf&#233; and &#x2014; a dash']);

    expect(extractLinesFromWordXml(xml)[0]).toBe('café and — a dash');
  });

  it('does not re-decode an escaped entity, which would turn data into markup', () => {
    // `&amp;#65;` is the literal text `&#65;`. Decoding numerics first would
    // produce `A`, which is the shape of most entity-handling bugs.
    const xml = buildWordDocumentXml(['&amp;#65;']);

    expect(extractLinesFromWordXml(xml)[0]).toBe('&#65;');
  });

  it('leaves an out-of-range character reference as the text it was', () => {
    // Failing a whole CV over one bad character reference would be the wrong
    // trade, and U+FFFD would put a replacement glyph into text the model then
    // reads as a word.
    const xml = buildWordDocumentXml(['bad &#1114112; reference']);

    expect(extractLinesFromWordXml(xml)[0]).toBe('bad &#1114112; reference');
  });

  it('keeps text that trails the last paragraph, however malformed the document', () => {
    const xml = '<w:p><w:r><w:t>Complete</w:t></w:r></w:p><w:r><w:t>Unclosed</w:t></w:r>';

    expect(extractLinesFromWordXml(xml)).toEqual(['Complete', 'Unclosed']);
  });

  it('finds nothing in a document with no text runs', () => {
    expect(extractLinesFromWordXml('<w:document><w:body/></w:document>')).toEqual(['']);
  });
});

describe('parseDocx', () => {
  it('reads a deflated archive, which is what Word writes', () => {
    const archive = buildDocx(['Priya Ramanathan', 'London, UK'], {
      method: ZIP_METHODS.DEFLATE,
    });

    expect(parseDocx(archive).text).toBe('Priya Ramanathan\nLondon, UK');
  });

  it('reads a stored archive, which some generators write', () => {
    const archive = buildDocx(['Priya Ramanathan', 'London, UK'], {
      method: ZIP_METHODS.STORED,
    });

    expect(parseDocx(archive).text).toBe('Priya Ramanathan\nLondon, UK');
  });

  it('collapses a run of empty paragraphs to a single blank line', () => {
    // A CV formatted with the Enter key rather than with styles can carry a
    // dozen in a row. One is kept, because it is real structure - it is what
    // separates the education block from the experience block.
    const archive = buildDocx(['EXPERIENCE', '', '', '', '', 'EDUCATION']);

    expect(parseDocx(archive).text).toBe('EXPERIENCE\n\nEDUCATION');
  });

  it('reports how many parts the package had, for the log', () => {
    expect(parseDocx(buildDocx(['Priya'])).entryCount).toBe(3);
  });

  it('fails a package whose archive cannot be opened at all', () => {
    // `parseDocx` cannot lean on the sniffer having already opened the archive.
    // The two read the file at different moments and, in the worker's case,
    // potentially from different bytes.
    const truncated = buildDocx(['Priya Ramanathan']).subarray(0, 60);

    expect(() => parseDocx(truncated)).toThrow(/central|ZIP|end-of-central/i);
  });

  it('fails a package whose main document part is listed but unreadable', () => {
    // The gap the sniffer cannot close: it reads `[Content_Types].xml` and
    // never touches `word/document.xml`, so an archive with a good declaration
    // and a broken document part sniffs as a DOCX and fails here.
    const archive = Buffer.from(buildDocx(['Priya Ramanathan']));
    // Located from the central directory rather than by searching for the name,
    // because the name also appears inside `[Content_Types].xml` - and a search
    // finds that copy first.
    const entry = findZipEntry(readZipDirectory(archive).entries, 'word/document.xml');
    expect(entry.localHeaderOffset).toBeGreaterThan(0);
    // Breaking the local header signature leaves the archive openable, the
    // entry listed, and its bytes unreachable.
    archive.writeUInt32LE(0x04034b51, entry.localHeaderOffset);

    let thrown;
    try {
      parseDocx(archive);
    } catch (error) {
      thrown = error;
    }

    expect(thrown.reason).toBe('zip_bad_local_header');
    expect(thrown.userMessage).toContain('could not be opened');
  });
});
