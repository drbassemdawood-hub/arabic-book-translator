# Book Translator — مترجم الكتب

Translate whole English books into Modern Standard Arabic (الفصحى) using the
Claude API — entirely in your browser.

**Live site:** https://arabic-book-translator.vercel.app

Upload a book (`.txt`, `.docx`, `.epub`, or `.pdf`), paste your own Claude API
key, and press **Start translation**. Built for large books — the same engine
as the Windows desktop version, tested with inputs the size of a 2000-page
novel.

## Private by design

There is no backend. This is a static page: your API key and your book go
straight from your browser to `api.anthropic.com` and nowhere else.

- The API key is stored (if "Remember" is checked) only in your browser's
  local storage.
- Translation progress is saved in your browser (IndexedDB) after **every
  passage** — if you cancel, lose connection, or close the tab, press **Start**
  again with the same book and it resumes where it stopped, never re-paying
  for finished passages.

## Options

| Option | What it does |
|---|---|
| **Model** | *Claude Opus* (default) gives the best literary quality. *Sonnet* is cheaper and faster; *Haiku* is cheapest. |
| **Speed** | *Careful* translates one passage at a time and feeds each passage the previous Arabic text — best consistency of names and style. *Fast/Fastest* run 3 or 6 passages in parallel (needs an API rate-limit tier that allows it). |
| **Output** | Word (.docx) fully Arabic right-to-left formatted, and/or plain text (.txt). For PDF, use the **Print / Save as PDF** button — the browser's own text engine renders perfect Arabic ligatures. |
| **Two-pass review** | After translating each passage, a second model call re-checks the draft against the English source and corrects omissions, mistranslations, and inconsistent names. Best accuracy; roughly doubles cost and time. On by default. |
| **Scanned PDFs (OCR)** | Pages with no text layer are detected automatically and read with Claude vision OCR (the estimated cost is shown first). OCR results are cached per page, so interruptions never redo OCR work. |

## Cost guide

Costs are billed to your own Anthropic account. Before starting, the activity
log shows an estimated cost and time for the whole book. Rough guide with the
default settings (Opus, two-pass review): a 300-page book ≈ $15–25; a
2000-page book ≈ $100–170. Turn off the review pass or choose Sonnet to cut
this substantially.

## Running locally

It's a static site — any web server works:

```bash
git clone https://github.com/drbassemdawood-hub/arabic-book-translator.git
cd arabic-book-translator
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly from disk won't work because the app uses JS
modules — serve it over HTTP as above.)

## Deploying

The site deploys to [Vercel](https://vercel.com) as-is (no build step):
import the repository and deploy, or `npx vercel` from the project folder.

## Under the hood

- Plain HTML/CSS/JS — no framework, no build step.
- Calls the Claude API directly from the browser (streaming) with the
  [`anthropic-dangerous-direct-browser-access`](https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/)
  header; "dangerous" refers to embedding a key in a site's code, which this
  app never does — you bring your own key.
- Text extraction: [pdf.js](https://mozilla.github.io/pdf.js/) (PDF),
  [JSZip](https://stuk.github.io/jszip/) (DOCX + EPUB). Both are vendored in
  `vendor/` so the site is fully self-contained.
- Arabic Word output is generated in the browser (OOXML with `bidi`
  right-to-left paragraphs).
- Resume state lives in IndexedDB, keyed by a SHA-256 fingerprint of the
  extracted text, so state from a different book or an edited source is never
  reused.
- Tests (`test/`) run the full flow in headless Chromium against a mocked
  Claude API, and verify the chunker byte-for-byte against the desktop
  original.

## Notes and limitations

- **PDF input**: digitally-created PDFs are read directly; scanned/image PDFs
  go through Claude vision OCR. OCR quality depends on scan quality.
- Keep the tab open while translating, and stop your computer from sleeping
  for very long runs. Interrupted runs resume with the Start button.
- Translated books are for your personal use — respect the copyright of the
  original work.

## Desktop version

This web app is a port of a Windows desktop app (Python + Tkinter) with the
same engine and options; the desktop version additionally supports free
offline OCR via Windows' built-in engine.
