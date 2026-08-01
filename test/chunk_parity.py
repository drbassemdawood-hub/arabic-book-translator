"""Verify the JS chunker matches the desktop (Python) chunker byte-for-byte.

Generates a battery of texts (normal prose, huge paragraphs, no sentence
breaks, messy whitespace, unicode), chunks them with the original Python
implementation, and writes them as JSON for the JS side to compare against.
"""
import json
import random
import re
import sys

CHUNK_MAX_CHARS = 10_000


def _split_long_paragraph(par: str, limit: int) -> list[str]:
    sentences = re.split(r"(?<=[.!?”\"])\s+", par)
    out, cur = [], ""
    for s in sentences:
        if cur and len(cur) + len(s) + 1 > limit:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
        while len(cur) > limit:
            out.append(cur[:limit])
            cur = cur[limit:]
    if cur:
        out.append(cur)
    return out


def chunk_text(text: str, limit: int = CHUNK_MAX_CHARS) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for par in paragraphs:
        pieces = [par] if len(par) <= limit else _split_long_paragraph(par, limit)
        for piece in pieces:
            if cur and cur_len + len(piece) + 2 > limit:
                chunks.append("\n\n".join(cur))
                cur, cur_len = [], 0
            cur.append(piece)
            cur_len += len(piece) + 2
    if cur:
        chunks.append("\n\n".join(cur))
    return chunks


def make_texts() -> dict[str, str]:
    rng = random.Random(42)
    words = ("the quick brown fox jumps over a lazy dog while Mr. Holmes "
             "watched from Baker Street with great interest and no small alarm").split()

    def sentence():
        n = rng.randint(4, 18)
        s = " ".join(rng.choice(words) for _ in range(n)).capitalize()
        return s + rng.choice([".", ".", ".", "!", "?", '."', ".”"])

    def paragraph(n_sent):
        return " ".join(sentence() for _ in range(n_sent))

    texts = {}
    texts["normal_book"] = "\n\n".join(paragraph(rng.randint(2, 12)) for _ in range(400))
    texts["huge_paragraph"] = paragraph(1200)  # one paragraph >> limit
    texts["no_sentence_breaks"] = "x" * 25_000  # pathological: no breaks at all
    texts["messy_whitespace"] = "  Para one. \n\n\n\n  Para two!  \n \n Para three?\n\nPara four.  "
    texts["short"] = "Hello world."
    texts["empty_ish"] = "\n\n   \n\n"
    texts["unicode"] = "\n\n".join(
        paragraph(rng.randint(2, 8)) + " — naïve café 4½ résumé."
        for _ in range(80)
    )
    texts["quotes_heavy"] = "\n\n".join(
        '"%s" said %s. “%s” he replied.' % (sentence(), rng.choice(words), sentence())
        for _ in range(300)
    )
    return texts


def main():
    texts = make_texts()
    out = {}
    for name, text in texts.items():
        out[name] = {"text": text, "chunks": chunk_text(text)}
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"wrote {len(out)} cases")


if __name__ == "__main__":
    main()
