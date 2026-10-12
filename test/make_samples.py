"""Generate sample books in all four formats for the e2e tests."""
import random
from pathlib import Path

OUT = Path(__file__).parent / "samples"
OUT.mkdir(exist_ok=True)

random.seed(7)
WORDS = ("the ancient library stood silent beneath the desert moon while scholars "
         "carried lanterns through its endless corridors of forgotten wisdom").split()


def sentence():
    n = random.randint(6, 14)
    return " ".join(random.choice(WORDS) for _ in range(n)).capitalize() + "."


def paragraph(n=None):
    return " ".join(sentence() for _ in range(n or random.randint(3, 7)))


CHAPTERS = [
    ("Chapter One — The Library", [paragraph() for _ in range(6)]),
    ("Chapter Two — The Lantern", [paragraph() for _ in range(6)]),
    ("Chapter Three — The Return", [paragraph() for _ in range(5)]),
]

MARKER = "The golden falcon returned at dawn."  # searchable phrase
CHAPTERS[1][1].insert(2, MARKER)

full_paragraphs = []
for title, pars in CHAPTERS:
    full_paragraphs.append(title)
    full_paragraphs.extend(pars)

# ---- .txt
(OUT / "sample.txt").write_text("\n\n".join(full_paragraphs), encoding="utf-8")

# ---- .docx
import docx  # noqa: E402

d = docx.Document()
for title, pars in CHAPTERS:
    d.add_heading(title, level=1)
    for p in pars:
        d.add_paragraph(p)
d.save(str(OUT / "sample.docx"))

# ---- .epub
from ebooklib import epub  # noqa: E402

book = epub.EpubBook()
book.set_identifier("sample-001")
book.set_title("The Ancient Library")
book.set_language("en")
book.add_author("Test Author")
items = []
for i, (title, pars) in enumerate(CHAPTERS):
    ch = epub.EpubHtml(title=title, file_name=f"ch{i}.xhtml", lang="en")
    ch.content = f"<h1>{title}</h1>" + "".join(f"<p>{p}</p>" for p in pars)
    book.add_item(ch)
    items.append(ch)
book.toc = items
book.add_item(epub.EpubNcx())
book.add_item(epub.EpubNav())
book.spine = ["nav"] + items
epub.write_epub(str(OUT / "sample.epub"), book)

# ---- .pdf (digital text layer)
import fitz  # noqa: E402

doc = fitz.open()
for title, pars in CHAPTERS:
    page = doc.new_page()
    text = title + "\n\n" + "\n\n".join(pars)
    page.insert_textbox(fitz.Rect(50, 50, 545, 790), text, fontsize=11)
doc.save(str(OUT / "sample.pdf"))
doc.close()

# ---- scanned.pdf (image-only pages -> OCR path)
doc = fitz.open()
src = fitz.open()
page = src.new_page()
page.insert_textbox(fitz.Rect(50, 50, 545, 790),
                    "Scanned page one. " + paragraph(4), fontsize=13)
pix = page.get_pixmap(dpi=120)
img_pdf = fitz.open()
p = img_pdf.new_page(width=595, height=842)
p.insert_image(fitz.Rect(0, 0, 595, 842), pixmap=pix)
# second scanned page
page2 = src.new_page()
page2.insert_textbox(fitz.Rect(50, 50, 545, 790),
                     "Scanned page two. " + paragraph(4), fontsize=13)
pix2 = page2.get_pixmap(dpi=120)
p2 = img_pdf.new_page(width=595, height=842)
p2.insert_image(fitz.Rect(0, 0, 595, 842), pixmap=pix2)
# plus one normal digital page
p3 = img_pdf.new_page(width=595, height=842)
p3.insert_textbox(fitz.Rect(50, 50, 545, 790),
                  "A digital page with a real text layer. " + paragraph(4), fontsize=12)
img_pdf.save(str(OUT / "scanned.pdf"))

# ---------------------------------------------------------------------------
# Books in the other source languages (Arabic, Chinese, Ukrainian, German):
# .txt, .docx and a digital .pdf each, with a searchable marker sentence, plus
# legacy-encoded .txt files. All sample sentences are original test text.
# ---------------------------------------------------------------------------
VENDOR = Path(__file__).parent.parent / "vendor"

LANG_SAMPLES = {
    "ar": {
        "words": ("وقفت المكتبة القديمة صامتة تحت ضوء القمر بينما حمل العلماء الفوانيس "
                  "عبر أروقتها الطويلة من الحكمة المنسية في المدينة").split(),
        "marker": "عاد الصقر الذهبي عند الفجر.",
        "titles": ["الفصل الأول — المكتبة", "الفصل الثاني — الفانوس"],
        "joiner": " ", "end": ".", "dir": "rtl", "font": "Amiri-Regular.ttf",
        "legacy": "cp1256",
    },
    "zh": {
        "words": ["古老的图书馆", "在月光下", "静静地矗立着", "学者们", "提着灯笼", "穿过",
                  "长长的走廊", "被遗忘的智慧", "城市的夜晚", "缓缓地"],
        "marker": "金色的猎鹰在黎明时分归来。",
        "titles": ["第一章——图书馆", "第二章——灯笼"],
        "joiner": "", "end": "。", "dir": "ltr", "font": "NotoSerifSC-Regular.ttf",
        "legacy": "gb18030",
    },
    "uk": {
        "words": ("стара бібліотека стояла тихо під місяцем і вчені несли ліхтарі "
                  "крізь довгі коридори забутої мудрості та її таємниць").split(),
        "marker": "Золотий сокіл повернувся на світанку.",
        "titles": ["Розділ перший — Бібліотека", "Розділ другий — Ліхтар"],
        "joiner": " ", "end": ".", "dir": "ltr", "font": "NotoSerif-Regular.ttf",
        "legacy": "cp1251",
    },
    "de": {
        "words": ("die alte Bibliothek stand still unter dem Mond und die Gelehrten "
                  "trugen Laternen durch die langen Gänge der vergessenen Weisheit").split(),
        "marker": "Der goldene Falke kehrte im Morgengrauen zurück.",
        "titles": ["Erstes Kapitel — Die Bibliothek", "Zweites Kapitel — Die Laterne"],
        "joiner": " ", "end": ".", "dir": "ltr", "font": "NotoSerif-Regular.ttf",
        "legacy": None,
    },
}


def lang_sentence(cfg):
    n = random.randint(5, 10)
    s = cfg["joiner"].join(random.choice(cfg["words"]) for _ in range(n))
    if cfg is LANG_SAMPLES["de"] or cfg is LANG_SAMPLES["uk"]:  # capitalize sentence starts
        s = s[0].upper() + s[1:]
    return s + cfg["end"]


def lang_paragraph(cfg):
    return cfg["joiner"].join(lang_sentence(cfg) for _ in range(random.randint(3, 6)))


for lang, cfg in LANG_SAMPLES.items():
    chapters = [(t, [lang_paragraph(cfg) for _ in range(5)]) for t in cfg["titles"]]
    chapters[1][1].insert(2, cfg["marker"])
    pars = []
    for title, ps in chapters:
        pars.append(title)
        pars.extend(ps)
    text = "\n\n".join(pars)

    (OUT / f"sample_{lang}.txt").write_text(text, encoding="utf-8")
    if cfg["legacy"]:
        (OUT / f"sample_{lang}_legacy.txt").write_bytes(text.encode(cfg["legacy"]))

    d = docx.Document()
    for title, ps in chapters:
        d.add_heading(title, level=1)
        for p in ps:
            d.add_paragraph(p)
    d.save(str(OUT / f"sample_{lang}.docx"))

    # digital PDF rendered with a real shaping engine (HarfBuzz via PyMuPDF
    # Story). For Arabic, PyMuPDF writes the shaped glyphs with a WRONG
    # character map — the text layer decodes to gibberish, a common fault in
    # real Arabic PDFs — so that file becomes the "corrupted text layer"
    # fixture; a correct Arabic PDF is printed by Chromium in e2e.mjs.
    pdf = fitz.open()
    archive = fitz.Archive(str(VENDOR))
    css = (f"@font-face {{font-family: bookfont; src: url({cfg['font']});}} "
           f"body {{font-family: bookfont; font-size: 12pt; direction: {cfg['dir']};}} "
           "h1 {font-size: 16pt;} p {margin-bottom: 8pt;}")
    for title, ps in chapters:
        page = pdf.new_page()
        html = f'<body dir="{cfg["dir"]}"><h1>{title}</h1>' + "".join(f"<p>{p}</p>" for p in ps) + "</body>"
        page.insert_htmlbox(fitz.Rect(50, 50, 545, 790), html, css=css, archive=archive)
    pdf.save(str(OUT / (f"sample_{lang}_garbled.pdf" if lang == "ar" else f"sample_{lang}.pdf")))
    pdf.close()

    # the page HTML, for printing a correct PDF in the browser (Arabic)
    (OUT / f"sample_{lang}.html").write_text(
        f'<!DOCTYPE html><html dir="{cfg["dir"]}"><head><meta charset="utf-8"><style>'
        f"@font-face {{font-family: bookfont; src: url(/vendor/{cfg['font']});}} "
        "body {font-family: bookfont; font-size: 13pt; margin: 2cm;} h1 {font-size: 17pt; break-before: page;}"
        "</style></head><body>"
        + "".join(f"<h1>{t}</h1>" + "".join(f"<p>{p}</p>" for p in ps) for t, ps in chapters)
        + "</body></html>",
        encoding="utf-8",
    )

# Traditional-Chinese book in Big5 (its bytes are ALSO valid GB18030 — the
# decoder must not be fooled), with a Traditional marker sentence
zh_trad_pars = ["第一章——圖書館"] + [
    "古老的圖書館在月光下靜靜地矗立著，學者們提著燈籠穿過被遺忘的智慧長廊。" * random.randint(2, 4)
    for _ in range(6)
]
zh_trad_pars.insert(3, "金色的獵鷹在黎明時分歸來。")
(OUT / "sample_zh_big5.txt").write_bytes("\n\n".join(zh_trad_pars).encode("big5"))

# An English book whose pages quote Arabic (printed to PDF by Chromium in
# e2e.mjs): such pages must NOT be mistaken for a corrupted text layer
ar_quote = "وقفت المكتبة القديمة صامتة تحت ضوء القمر، وحمل العلماء فوانيسهم عبر أروقة الحكمة المنسية."
en_quote_pars = []
for i in range(8):
    en_quote_pars.append(f"<p>{paragraph()}</p>")
    en_quote_pars.append(f'<p dir="rtl" lang="ar">{ar_quote} {ar_quote}</p>')
en_quote_pars.insert(5, f"<p>{MARKER}</p>")
(OUT / "sample_en_quotes.html").write_text(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    "@font-face {font-family: ar; src: url(/vendor/Amiri-Regular.ttf);} "
    "body {font-family: Georgia, serif; font-size: 12pt; margin: 2cm;} p[dir=rtl] {font-family: ar;}"
    "</style></head><body><h1>Chapter One — Sayings</h1>" + "".join(en_quote_pars) + "</body></html>",
    encoding="utf-8",
)


def image_page(doc, text):
    """Append an image-only (scanned) page showing `text`."""
    tmp = fitz.open()
    pg = tmp.new_page()
    pg.insert_textbox(fitz.Rect(50, 50, 545, 790), text, fontsize=13)
    pix = pg.get_pixmap(dpi=100)
    page = doc.new_page(width=595, height=842)
    page.insert_image(fitz.Rect(0, 0, 595, 842), pixmap=pix)


# A scanned Arabic book whose only digital page is an English library notice:
# that one page must not decide the book's language before OCR
doc = fitz.open()
notice = doc.new_page(width=595, height=842)
notice.insert_textbox(fitz.Rect(50, 50, 545, 400),
                      "This book was digitized by the library of the university and is made available "
                      "for the use of the students and for the public.", fontsize=11)
for k in range(6):
    image_page(doc, f"Scanned book page {k + 1}. " + paragraph(3))
doc.save(str(OUT / "sample_ar_scan_notice.pdf"))

# A mostly digital English book with one scanned page: its text layer IS
# representative, so a wrong pair is caught before any OCR is paid for
doc = fitz.open()
for k in range(4):
    page = doc.new_page(width=595, height=842)
    page.insert_textbox(fitz.Rect(50, 50, 545, 790), f"Digital page {k + 1}. " + paragraph(5), fontsize=11)
image_page(doc, "Scanned page. " + paragraph(3))
doc.save(str(OUT / "sample_en_mostly_digital.pdf"))

# An Arabic Islamic religious text (original test sentences in the style of a
# hadith/sira work), for the book-level religious convention
islamic = [
    "قال رسول الله صلى الله عليه وسلم في خطبته: إن الأعمال بالنيات، وإن لكل امرئ ما نوى.",
    "وروى أبو هريرة رضي الله عنه أن النبي ﷺ كان يوصي أصحابه بالصبر والرفق بالناس.",
    "قال تعالى: ﴿وَمَا أَرْسَلْنَاكَ إِلَّا رَحْمَةً لِلْعَالَمِينَ﴾، وقد فسره العلماء رحمهم الله بأوجه متعددة.",
    "ثم مضى الكتاب في ذكر أحوال الناس في المدينة، وما كانوا عليه من التعاون في أوقات الشدة.",
]
pars = ["الفصل الأول — في النية"] + [" ".join(islamic) for _ in range(6)]
pars.insert(3, LANG_SAMPLES["ar"]["marker"])
(OUT / "sample_ar_islamic.txt").write_text("\n\n".join(pars), encoding="utf-8")

print("samples written:", sorted(f.name for f in OUT.iterdir()))
