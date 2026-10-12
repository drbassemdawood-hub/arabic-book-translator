# Book Translator — مترجم الكتب

Translate whole books between Arabic (الفصحى) and English, Ukrainian,
Chinese (Mandarin) or German using the Claude API — entirely in your browser.

| Direction | |
|---|---|
| English → Arabic | Arabic → English |
| Arabic → Ukrainian | Ukrainian → Arabic |
| Arabic → Chinese (Mandarin, Simplified characters) | Chinese → Arabic |
| Arabic → German | German → Arabic |

**Live site:** https://arabic-book-translator.vercel.app

Upload a book (`.txt`, `.docx`, `.epub`, or `.pdf`), paste your own Claude API
key, and press **Start translation**. Built for large books — the same engine
as the Windows desktop version, tested with inputs the size of a 2000-page
novel.

## Private by design

There is no backend. This is a static page: your API key and your book go
straight from your browser to `api.anthropic.com` and nowhere else.

- The API key is entered once (🔑 API key button) and — if "Remember" is
  checked — stored only in your browser's local storage, so it's filled in
  automatically on your next visit.
- Translation progress is saved in your browser (IndexedDB) after **every
  passage** — if you cancel, lose connection, or close the tab, press **Start**
  again with the same book and it resumes where it stopped, never re-paying
  for finished passages.

## Options

| Option | What it does |
|---|---|
| **Translate** | The language direction (eight choices, above). Each direction has its own translation rules: target-language style and punctuation conventions, established forms of names, and — for Arabic sources — careful handling of Qur'an and Hadith quotations and religious formulas. For an Arabic book the app decides once, from the whole text, whether it reads as an Islamic religious work, a Christian work or general writing, and every passage then renders الله, the honorific formulas and the prophets' names the same way (e.g. "God" or "Allah", „Gott“ or „Allah“, «Аллах» or «Бог», 真主 or 上帝); the choice is shown in the log. Before anything is sent for translation, the app checks that the book really is in the chosen source language and asks if it looks otherwise. |
| **Model** | *Claude Opus* (default) gives the best literary quality. *Sonnet* is cheaper and faster; *Haiku* is cheapest. |
| **Speed** | *Careful* translates one passage at a time and feeds each passage the previous translated text — best consistency of names and style. *Fast/Fastest* run 3 or 6 passages in parallel (needs an API rate-limit tier that allows it). |
| **Output** | Word (.docx) and PDF (.pdf) and/or plain text (.txt), formatted for the target language: right-to-left for Arabic, left-to-right otherwise; files are named `<book>.<language>.docx` (e.g. `.ar`, `.en`, `.uk`, `.zh`, `.de`). A browser Print view is also available as an alternative way to make a PDF. |
| **Two-pass review** | After translating each passage, a second model call re-checks the draft against the source and corrects omissions, mistranslations, and inconsistent names. Best accuracy; roughly doubles cost and time. On by default. |
| **Scanned PDFs (OCR)** | Pages with no text layer — and pages whose text layer is corrupted (a common fault in Arabic PDFs: the characters decode to gibberish) — are detected automatically and read with Claude vision OCR (the estimated cost is shown first). OCR results are cached per page, so interruptions never redo OCR work. |

## Cost guide

Costs are billed to your own Anthropic account. Before starting, the activity
log shows an estimated cost and time for the whole book. Rough guide for
English → Arabic with the default settings (Opus, two-pass review): a 300-page
book ≈ $15–25; a 2000-page book ≈ $100–170; the other directions are in the
same range. Turn off the review pass or choose Sonnet to cut this
substantially.

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
- Word output is generated in the browser (OOXML: right-to-left `bidi`
  paragraphs for Arabic, East-Asian fonts for Chinese, language tags for
  spell-checking).
- PDF output is generated in the browser with
  [jsPDF](https://github.com/parallax/jsPDF) and three embedded fonts (all
  SIL OFL, see `vendor/FONTS-LICENSE.txt`): [Amiri](https://www.amirifont.org/)
  for Arabic, [Noto Serif](https://notofonts.github.io/) for Latin and
  Cyrillic, and Noto Serif SC for Chinese (subset to the 6,763 GB2312
  characters by `tools/make_fonts.py`). Each character is drawn with the first
  font that has it. Arabic gets contextual letter shaping
  ([arabic-reshaper](https://github.com/louy/Javascript-Arabic-Reshaper)) plus
  the full Unicode bidirectional algorithm
  ([bidi-js](https://github.com/lojjic/bidi-js)), verified glyph-by-glyph
  against the reference Python implementations (`test/artext_parity.mjs`,
  `test/validate_pdf.py`); Chinese lines break between characters without
  starting a line with closing punctuation (`test/validate_multilang.py`).
- Language rules and prompts for every direction live in `js/languages.js`.
- Resume state lives in IndexedDB, keyed by a SHA-256 fingerprint of the
  extracted text and the language direction, so state from a different book,
  an edited source, or another direction is never reused.
- Tests (`test/`) run the full flow in headless Chromium against a mocked
  Claude API, and verify the chunker byte-for-byte against the desktop
  original.

## Notes and limitations

- **PDF input**: digitally-created PDFs are read directly (Arabic lines in
  right-to-left order, Chinese without inserted spaces); scanned/image PDFs and
  PDFs with a corrupted text layer go through Claude vision OCR. OCR quality
  depends on scan quality.
- **Chinese PDF output** covers the 6,763 standard Simplified characters; if a
  rarer character appears, the app says so and the Word file and Print view
  show it correctly.
- Keep the tab open while translating, and stop your computer from sleeping
  for very long runs. Interrupted runs resume with the Start button.
- Translated books are for your personal use — respect the copyright of the
  original work.

## Desktop version

This web app is a port of a Windows desktop app (Python + Tkinter) with the
same engine and options; the desktop version additionally supports free
offline OCR via Windows' built-in engine.
