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


def is_scan(page, text: str) -> bool:
    resources = page.get("/Resources")
    xobjects = resources.get_object().get("/XObject") if resources is not None else None
    if xobjects is None:
        return False
    images = any(x.get_object().get("/Subtype") == "/Image" for x in xobjects.get_object().values())
    return images and len(re.sub(r"\s", "", text)) < SCAN_TEXT_CHARS


def main() -> None:
    try:
        reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
        if reader.is_encrypted:
            print(json.dumps({"error": "encrypted"}))
            return
        pages = len(reader.pages)
        texts = [reader.pages[i].extract_text() or "" for i in range(min(pages, MAX_PAGES))]
        scanned = sum(1 for i, t in enumerate(texts) if is_scan(reader.pages[i], t))
        # At least half the pages read are scans: the PDF goes to OCR.
        scan = scanned > 0 and scanned * 2 >= len(texts)
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
    print(json.dumps({"pages": pages, "text": text, "truncated": pages > MAX_PAGES, "scan": scan}, ensure_ascii=False))


main()
