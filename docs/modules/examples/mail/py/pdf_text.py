"""Only text is taken: pypdf never runs the file's JavaScript, form actions or embedded files.
"""

import io
import json
import re
import sys
import unicodedata

from pypdf import PdfReader
from pypdf.errors import LimitReachedError, PdfReadError

MAX_PAGES = 50
# A scanner app may stamp a short line of text on a page that is otherwise one image.
SCAN_TEXT_CHARS = 20


def main() -> None:
    try:
        reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
        if reader.is_encrypted:
            print(json.dumps({"error": "encrypted"}))
            return
        pages = len(reader.pages)
        texts = [reader.pages[i].extract_text() or "" for i in range(min(pages, MAX_PAGES))]
        text = "\n\n".join(texts)
    except LimitReachedError:
        print(json.dumps({"error": "too-big"}))
        return
    except (PdfReadError, ValueError, KeyError, TypeError):
        print(json.dumps({"error": "unreadable"}))
        return
    # NFKC folds the Kangxi radicals some PDFs carry (U+2F8F for 行) back to ordinary characters.
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", text)).strip()
    reply = {"pages": pages, "text": text, "truncated": pages > MAX_PAGES}
    thin = [i for i, t in enumerate(texts) if len(re.sub(r"\s", "", t)) < SCAN_TEXT_CHARS]
    # The PDF goes to OCR when at least half the pages read are scans; pdf_scan.py checks the nearly empty ones for an image.
    if thin and len(thin) * 2 >= len(texts):
        reply["scanCheck"] = {"pages": thin, "need": (len(texts) + 1) // 2}
    print(json.dumps(reply, ensure_ascii=False))


main()
