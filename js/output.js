/* Output generation: Arabic .docx and .txt downloads, and a print view for
 * saving as PDF (the browser's own text engine gives perfect Arabic shaping). */

const ARABIC_FONTS = `"Traditional Arabic", "Amiri", "Scheherazade New", "Noto Naskh Arabic", "Times New Roman", serif`;

function xmlEscape(s) {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split translated chunks into clean paragraphs. */
function toParagraphs(translatedChunks) {
  const out = [];
  for (const text of translatedChunks) {
    for (const par of text.split("\n\n")) {
      const p = par.trim();
      if (p) out.push(p);
    }
  }
  return out;
}

// ------------------------------------------------------------------------ docx

function runProps(halfPoints, bold) {
  return (
    `<w:rPr><w:rFonts w:ascii="Traditional Arabic" w:hAnsi="Traditional Arabic" w:cs="Traditional Arabic"/>` +
    (bold ? "<w:b/><w:bCs/>" : "") +
    `<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/><w:rtl/></w:rPr>`
  );
}

/** One right-to-left Arabic paragraph (same layout the desktop app produces). */
function paragraphXml(text, { points = 14, bold = false } = {}) {
  const rpr = runProps(points * 2, bold);
  return (
    `<w:p><w:pPr><w:bidi/><w:jc w:val="right"/>${rpr}</w:pPr>` +
    `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
  );
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export async function buildDocxBlob(translatedChunks, title) {
  const body = [paragraphXml(title, { points: 20, bold: true })];
  for (const par of toParagraphs(translatedChunks)) body.push(paragraphXml(par));

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}<w:sectPr><w:bidi/></w:sectPr></w:body></w:document>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}

// ------------------------------------------------------------------------- txt

export function buildTxtBlob(translatedChunks) {
  return new Blob([translatedChunks.join("\n\n")], { type: "text/plain;charset=utf-8" });
}

// -------------------------------------------------------------------- download

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ------------------------------------------------------------------ print view

/** Open the translation in a print-ready window; the user saves it as a PDF
 * with the browser's print dialog (perfect Arabic ligatures, free, offline). */
export function openPrintView(translatedChunks, title) {
  const paragraphs = toParagraphs(translatedChunks);
  const win = window.open("", "_blank");
  if (!win) return false; // popup blocked
  const doc = win.document;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<title>${htmlEscape(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap" rel="stylesheet">
<style>
  @page { margin: 2cm; }
  html { direction: rtl; }
  body {
    font-family: ${ARABIC_FONTS};
    font-size: 15pt; line-height: 2; color: #1a1a1a;
    max-width: 17.5cm; margin: 0 auto; padding: 24px 16px;
    direction: rtl; text-align: right;
  }
  h1 { text-align: center; font-size: 23pt; font-weight: 700; margin: 0 0 1.2em; }
  p { margin: 0 0 0.65em; }
  .toolbar {
    position: sticky; top: 0; background: #0d5c4d; color: #fff;
    padding: 10px 16px; border-radius: 10px; margin-bottom: 20px;
    font-family: system-ui, sans-serif; font-size: 12pt; direction: ltr; text-align: left;
  }
  .toolbar button {
    font: inherit; margin-inline-end: 10px; padding: 4px 14px; border: 0;
    border-radius: 7px; background: #fff; color: #0d5c4d; cursor: pointer; font-weight: 600;
  }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<div class="toolbar">
  <button onclick="window.print()">🖨 Print / Save as PDF</button>
  Choose “Save as PDF” as the destination in the print dialog.
</div>
<h1>${htmlEscape(title)}</h1>
${paragraphs.map((p) => `<p>${htmlEscape(p)}</p>`).join("\n")}
</body>
</html>`);
  doc.close();
  return true;
}
