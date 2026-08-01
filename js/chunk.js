/* Splitting the book into translation passages.
 * Faithful port of the desktop app's chunker (verified against it in
 * test/chunk-parity): paragraphs are never split unless a single paragraph
 * exceeds the limit, in which case it is split at sentence boundaries.
 */

export const CHUNK_MAX_CHARS = 10000; // source characters per API request

function splitLongParagraph(par, limit) {
  const sentences = par.split(/(?<=[.!?”"])\s+/);
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > limit) {
      out.push(cur);
      cur = s;
    } else {
      cur = `${cur} ${s}`.trim();
    }
    while (cur.length > limit) { // pathological: no sentence breaks
      out.push(cur.slice(0, limit));
      cur = cur.slice(limit);
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
