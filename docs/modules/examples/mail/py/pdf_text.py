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


# Merged, optimized and print-to-PDF files often wrap the page image in a Form XObject.
FORM_DEPTH = 4


def dictionary(value):
    return value.get_object() if value is not None else {}


def has_image(holder, depth: int, seen: set) -> bool:
    xobjects = dictionary(dictionary(holder.get("/Resources")).get("/XObject"))
    for ref in xobjects.values():
        xobject = dictionary(ref)
        subtype = xobject.get("/Subtype")
        if subtype == "/Image":
            return True
        if subtype == "/Form" and depth > 0 and id(xobject) not in seen:
            seen.add(id(xobject))
            if has_image(xobject, depth - 1, seen):
                return True
    return False


def is_scan(page, text: str) -> bool:
    if len(re.sub(r"\s", "", text)) >= SCAN_TEXT_CHARS:
        return False
    try:
        return has_image(page, FORM_DEPTH, set())
    except Exception:
        # A guess that breaks on a damaged page means not a scan: the text already read stands.
        return False


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
