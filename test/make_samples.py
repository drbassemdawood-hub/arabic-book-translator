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

print("samples written:", sorted(f.name for f in OUT.iterdir()))
