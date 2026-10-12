/* Splitting the book into translation passages.
 * Faithful port of the desktop app's chunker (verified against it in
 * test/chunk-parity): paragraphs are never split unless a single paragraph
 * exceeds the limit, in which case it is split at sentence boundaries.
 *
 * Beyond the desktop original (which only knew English), sentence boundaries
 * also include the Arabic question mark and closing guillemets, and Chinese
 * full-width terminators (。！？), which are NOT followed by a space. Text
 * without those characters is split exactly as before.
 */

export const CHUNK_MAX_CHARS = 10000; // default source characters per API request

// whitespace after sentence-final punctuation: the original rule, plus the
// Arabic question mark and terminators closed by guillemets or the German
// closing quote (.» ?« !“). Only characters English prose never uses in that
// position are added, so English text splits exactly as before.
const WS_BOUNDARY = /(?<=[.!?”"]|[.!?…؟][»«“]+|؟[”’)]*)\s+/u;
// directly after a Chinese terminator (and any closing quotes after it)
const CJK_BOUNDARY = /(?<=[。！？][”’」』）]*)(?![”’」』）])/u;

/** Sentences with the glue that joins each one to the previous ("" between Chinese sentences). */
function sentences(par) {
  const out = [];
  for (const piece of par.split(WS_BOUNDARY)) {
    piece.split(CJK_BOUNDARY).forEach((s, k) => {
      if (s) out.push({ s, glue: k === 0 ? " " : "" });
    });
  }
  return out;
}

/** Cut position <= limit that does not split a surrogate pair. */
function safeCut(s, limit) {
  const c = s.charCodeAt(limit - 1);
  return c >= 0xd800 && c <= 0xdbff ? limit - 1 : limit;
}

function splitLongParagraph(par, limit) {
  const out = [];
  let cur = "";
  for (const { s, glue } of sentences(par)) {
    if (cur && cur.length + s.length + glue.length > limit) {
      out.push(cur);
      cur = s;
    } else {
      cur = glue ? `${cur} ${s}`.trim() : cur + s;
    }
    while (cur.length > limit) { // pathological: no sentence breaks
      const cut = safeCut(cur, limit);
      out.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkText(text, limit = CHUNK_MAX_CHARS) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const par of paragraphs) {
    const pieces = par.length <= limit ? [par] : splitLongParagraph(par, limit);
    for (const piece of pieces) {
      if (cur.length && curLen + piece.length + 2 > limit) {
        chunks.push(cur.join("\n\n"));
        cur = [];
        curLen = 0;
      }
      cur.push(piece);
      curLen += piece.length + 2;
    }
  }
  if (cur.length) chunks.push(cur.join("\n\n"));
  return chunks;
}
