"""Reads a PDF from stdin and prints one JSON line: {"pages", "text", "truncated"} or {"error"}.

Only text is taken: pypdf never runs the file's JavaScript, form actions or embedded files.
"""

import io
import json
import re
import sys
import unicodedata

from pypdf import PdfReader
from pypdf.errors import LimitReachedError, PdfReadError

MAX_PAGES = 50


def main() -> None:
    try:
        reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
        if reader.is_encrypted:
            print(json.dumps({"error": "encrypted"}))
            return
        pages = len(reader.pages)
        text = "\n\n".join(reader.pages[i].extract_text() or "" for i in range(min(pages, MAX_PAGES)))
    except LimitReachedError:
        print(json.dumps({"error": "too-big"}))
        return
    except (PdfReadError, ValueError, KeyError, TypeError):
        print(json.dumps({"error": "unreadable"}))
        return
    # NFKC folds the Kangxi radicals some PDFs carry (U+2F8F for 行) back to ordinary characters.
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", text)).strip()
    print(json.dumps({"pages": pages, "text": text, "truncated": pages > MAX_PAGES}, ensure_ascii=False))


main()
