// Tests for lib/officeText.js -- OOXML (.docx/.xlsx) text extraction.
// Builds minimal stored-entry (method 0) ZIP archives in-test so there are no
// dependencies; the DEFLATE (method 8) path is exercised against real files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOfficeText, isOfficeMime } from "../src/lib/officeText.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Build a minimal valid ZIP (all entries stored, method 0) from a name->string
 * map. Mirrors the central-directory layout officeText.js reads.
 * @param {Record<string,string>} files
 * @returns {ArrayBuffer}
 */
function buildZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true); // method = stored
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true); // method = stored
    cv.setUint32(20, data.length, true); // compressed size
    cv.setUint32(24, data.length, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const cdOffset = offset;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out.buffer;
}

test("isOfficeMime recognizes docx and xlsx, rejects others", () => {
  assert.equal(isOfficeMime(DOCX_MIME), true);
  assert.equal(isOfficeMime(XLSX_MIME), true);
  assert.equal(isOfficeMime("application/pdf"), false);
  assert.equal(isOfficeMime("image/png"), false);
  assert.equal(isOfficeMime(""), false);
});

test("extractOfficeText: docx paragraphs, breaks, and entity decoding", async () => {
  const documentXml =
    '<?xml version="1.0"?><w:document><w:body>' +
    "<w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Col1</w:t><w:tab/><w:t>Col2</w:t></w:r></w:p>" +
    "</w:body></w:document>";
  const buf = buildZip({ "word/document.xml": documentXml });
  const text = await extractOfficeText(buf, DOCX_MIME);

  assert.match(text, /Hello & welcome/);
  assert.match(text, /Line one\nLine two/);
  assert.match(text, /Col1\tCol2/);
});

test("extractOfficeText: xlsx resolves shared strings into rows", async () => {
  const sharedStrings =
    '<?xml version="1.0"?><sst><si><t>Name</t></si><si><t>Acme Corp</t></si></sst>';
  const workbook =
    '<?xml version="1.0"?><workbook><sheets><sheet name="Clients" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const sheet1 =
    '<?xml version="1.0"?><worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>99</v></c></row>' +
    "</sheetData></worksheet>";
  const buf = buildZip({
    "xl/sharedStrings.xml": sharedStrings,
    "xl/workbook.xml": workbook,
    "xl/worksheets/sheet1.xml": sheet1,
  });
  const text = await extractOfficeText(buf, XLSX_MIME);

  assert.match(text, /### Clients/);
  assert.match(text, /Name\t42/);
  assert.match(text, /Acme Corp\t99/);
});

test("extractOfficeText: empty/garbage buffer throws (caller catches)", async () => {
  await assert.rejects(() => extractOfficeText(new Uint8Array([1, 2, 3]).buffer, DOCX_MIME));
});
