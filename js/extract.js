/* Text extraction: .txt, .docx, .epub, .pdf — all in the browser. */

const OCR_MIN_TEXT_CHARS = 30; // a PDF page with less text than this + an image = scanned

let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL("vendor/pdf.min.mjs", document.baseURI).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", document.baseURI).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

// ------------------------------------------------------------------- plain text

export async function extractTxt(file) {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes); // legacy files
  }
}

// ------------------------------------------------------------------------ docx

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function extractDocx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a valid .docx file (no word/document.xml).");
  const xml = new DOMParser().parseFromString(await docFile.async("string"), "application/xml");
  const paragraphs = [];
  for (const p of xml.getElementsByTagNameNS(W_NS, "p")) {
    let text = "";
    const walker = xml.createTreeWalker(p, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.namespaceURI !== W_NS) continue;
      if (node.localName === "t") text += node.textContent;
      else if (node.localName === "tab") text += "\t";
      else if (node.localName === "br" || node.localName === "cr") text += "\n";
    }
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
}

// ------------------------------------------------------------------------ epub

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr", "blockquote",
]);
const SKIP_TAGS = new Set(["script", "style", "head", "title"]);

/** HTML -> text with paragraph breaks at block boundaries. */
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName;
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push("\n\n");
    for (const child of node.childNodes) walk(child);
    if (block) parts.push("\n\n");
  };
  walk(doc.documentElement);
  let raw = parts.join("");
  raw = raw.replace(/[ \t\u00A0]+/g, " ");
  raw = raw.replace(/ ?\n ?/g, "\n");
  raw = raw.replace(/\n{3,}/g, "\n\n");
  return raw.trim();
}

function resolveHref(baseDir, href) {
  // resolve "../text/ch1.xhtml" against the OPF's directory, drop #fragments
  const clean = decodeURIComponent(href.split("#")[0]);
  const stack = baseDir ? baseDir.split("/") : [];
  for (const part of clean.split("/")) {
    if (part === "..") stack.pop();
    else if (part !== "." && part !== "") stack.push(part);
  }
  return stack.join("/");
}

export async function extractEpub(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  let docPaths = [];
  try {
    const container = new DOMParser().parseFromString(
      await zip.file("META-INF/container.xml").async("string"), "application/xml");
    const opfPath = container.getElementsByTagName("rootfile")[0].getAttribute("full-path");
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
    const opf = new DOMParser().parseFromString(await zip.file(opfPath).async("string"), "application/xml");

    const manifest = {}; // id -> { href, type }
    for (const item of opf.getElementsByTagName("item")) {
      manifest[item.getAttribute("id")] = {
        href: item.getAttribute("href"),
        type: item.getAttribute("media-type") || "",
      };
    }
    for (const ref of opf.getElementsByTagName("itemref")) {
      const item = manifest[ref.getAttribute("idref")];
      if (item && (item.type.includes("html") || /\.x?html?$/i.test(item.href))) {
        docPaths.push(resolveHref(opfDir, item.href));
      }
    }
  } catch {
    docPaths = [];
  }
  if (!docPaths.length) {
    // fallback: every HTML file in the archive, in zip order
    zip.forEach((path) => {
      if (/\.x?html?$/i.test(path)) docPaths.push(path);
    });
  }

  const parts = [];
  for (const path of docPaths) {
    const entry = zip.file(path);
    if (!entry) continue;
    const text = htmlToText(await entry.async("string"));
    if (text) parts.push(text);
  }
  if (!parts.length) throw new Error("No readable chapters found in this EPUB.");
  return parts.join("\n\n");
}

// ------------------------------------------------------------------------- pdf

const SENTENCE_END = /[.!?:؟”"']\s*$/;

/** Join per-page text into flowing prose (same rules as the desktop app):
 * - a page that ends mid-sentence continues into the next page;
 * - hyphen-split words (exam-\nple) are stitched back together;
 * - remaining single newlines inside sentences become spaces.
 */
export function joinPdfPages(pages) {
  const parts = [];
  for (let pageText of pages) {
    pageText = pageText.trim();
    if (!pageText) continue;
    if (parts.length) {
      parts.push(SENTENCE_END.test(parts[parts.length - 1]) ? "\n\n" : "\n");
    }
    parts.push(pageText);
  }
  let text = parts.join("");
  text = text.replace(/([\p{L}\p{N}_])-\n(?!\n)(?=[\p{L}\p{N}_])/gu, "$1"); // de-hyphenate
  return text.replace(/(?<![.!?:؟”"\n])\n(?!\n)/g, " "); // merge broken lines
}

/** Rebuild one page's text from pdf.js text items (line breaks + word gaps). */
function pageTextFromItems(items) {
  const lines = [];
  let line = [];
  let last = null;
  for (const it of items) {
    if (it.str === undefined) continue;
    if (last && !last.hasEOL) {
      const dy = Math.abs((it.transform?.[5] ?? 0) - (last.transform?.[5] ?? 0));
      if (dy > 2) {
        lines.push(line.join(""));
        line = [];
      } else {
        const gap = (it.transform?.[4] ?? 0) - ((last.transform?.[4] ?? 0) + (last.width || 0));
        if (gap > 1 && line.length && !/\s$/.test(last.str) && !/^\s/.test(it.str)) line.push(" ");
      }
    }
    line.push(it.str);
    if (it.hasEOL) {
      lines.push(line.join(""));
      line = [];
    }
    last = it;
  }
  if (line.length) lines.push(line.join(""));
  return lines.join("\n");
}

/** True if the operator list paints an image covering ≥ `minFraction` of the
 * page. Tracks only the CTM determinant (all we need for areas). */
async function hasBigImage(pdfjs, page, minFraction) {
  const ops = await page.getOperatorList();
  const [x0, y0, x1, y1] = page.view;
  const pageArea = Math.abs((x1 - x0) * (y1 - y0)) || 1;
  const { OPS } = pdfjs;
  let det = 1;
  const stack = [];
  let found = false;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(det);
    else if (fn === OPS.restore) det = stack.length ? stack.pop() : det;
    else if (fn === OPS.transform) det *= args[0] * args[3] - args[1] * args[2];
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(det);
      const m = args && args[0];
      if (m) det *= m[0] * m[3] - m[1] * m[2];
    } else if (fn === OPS.paintFormXObjectEnd) det = stack.length ? stack.pop() : det;
    else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintImageXObjectRepeat
    ) {
      if (Math.abs(det) >= minFraction * pageArea) {
        found = true;
        break;
      }
    }
  }
  return found;
}

/** Open a PDF and expose what the engine needs: per-page text, scanned-page
 * detection, and page rendering for OCR. */
export async function openPdf(file) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const numPages = doc.numPages;

  const pageTexts = [];
  const scanned = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = pageTextFromItems(content.items).trim();
    pageTexts.push(text);
    // A page needs OCR if it has (almost) no text layer but carries an image —
    // including scans whose only "text" is a watermark on a full-page image.
    if (text.length < 200) {
      try {
        if (text.length < OCR_MIN_TEXT_CHARS) {
          if (await hasBigImage(pdfjs, page, 0.0)) scanned.push(i - 1); // any image at all
        } else if (await hasBigImage(pdfjs, page, 0.8)) {
          scanned.push(i - 1);
        }
      } catch {
        if (text.length < OCR_MIN_TEXT_CHARS) scanned.push(i - 1); // conservative fallback
      }
    }
  }

  return {
    numPages,
    pageTexts,
    scannedPages: scanned,
    /** Render page `i` (0-based) to a PNG, long edge `maxEdge` px; returns base64. */
    async renderPagePngBase64(i, maxEdge) {
      const page = await doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = maxEdge / Math.max(base.width, base.height, 1);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000;
      for (let o = 0; o < buf.length; o += CHUNK) {
        binary += String.fromCharCode.apply(null, buf.subarray(o, o + CHUNK));
      }
      return btoa(binary);
    },
    destroy() {
      try {
        Promise.resolve(task.destroy()).catch(() => {});
      } catch {
        /* already destroyed */
      }
    },
  };
}

// -------------------------------------------------------------------- registry

export const SUPPORTED_EXTENSIONS = [".txt", ".docx", ".epub", ".pdf"];

export function fileExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Extract full text for non-PDF files (PDFs go through openPdf + OCR). */
export async function extractSimple(file) {
  const ext = fileExtension(file.name);
  if (ext === ".txt") return extractTxt(file);
  if (ext === ".docx") return extractDocx(file);
  if (ext === ".epub") return extractEpub(file);
  throw new Error(`Unsupported file type: ${ext}`);
}
