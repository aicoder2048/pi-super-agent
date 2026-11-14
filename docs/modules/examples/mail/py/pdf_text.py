"""Only text is taken: pypdf never runs the file's JavaScript, form actions or embedded files.
"""

import io
import json
import re
import sys
import unicodedata

from pypdf import PdfReader
from pypdf.errors import LimitReachedError, PdfReadError
from pypdf.generic import IndirectObject

MAX_PAGES = 50
# A scanner app may stamp a short line of text on a page that is otherwise one image.
SCAN_TEXT_CHARS = 20


# Merged, optimized and print-to-PDF files often wrap the page image in a Form XObject.
FORM_DEPTH = 4
# Entries the guess lets pypdf parse in all, whatever the PDF's structure: pages and Forms may share one table of
# thousands of Forms, or each Form may carry its own. Out of work, the remaining pages count as not scans.
SCAN_WORK = 5000


class OutOfWork(Exception):
    pass


def dictionary(value):
    return value.get_object() if value is not None else {}


def entries(obj, cap: int) -> int:
    """Entries in obj's direct dictionaries and arrays, counted up to just past cap: what resolving obj made pypdf parse."""
    count, todo = 0, [obj]
    while todo and count <= cap:
        item = todo.pop()
        if isinstance(item, (dict, list)):
            count += len(item)
            if count <= cap:
                todo.extend(item.values() if isinstance(item, dict) else item)
    return count


class ScanGuess:
    def __init__(self) -> None:
        self.work = SCAN_WORK
        # Whether an /XObject table holds an image within a depth, keyed by the first indirect object it lives in.
        self.known: dict[tuple[int, int, int], bool] = {}

    def spend(self, obj) -> None:
        cost = entries(obj, self.work)
        if cost > self.work:
            self.work = 0
            raise OutOfWork
        self.work -= cost

    def has_image(self, holder, holder_ref, depth: int) -> bool:
        resources = holder.get("/Resources")
        table = dictionary(resources).get("/XObject")
        ref = next((r for r in (table, resources, holder_ref) if isinstance(r, IndirectObject)), None)
        key = None if ref is None else (ref.idnum, ref.generation, depth)
        if key in self.known:
            return self.known[key]
        found = self.scan_table(dictionary(table), depth)
        if key is not None:
            self.known[key] = found
        return found

    def scan_table(self, table, depth: int) -> bool:
        self.spend(table)
        for ref in table.values():
            xobject = dictionary(ref)
            self.spend(xobject)
            subtype = xobject.get("/Subtype")
            if subtype == "/Image":
                return True
            if subtype == "/Form" and depth > 0 and self.has_image(xobject, ref, depth - 1):
                return True
        return False

    def is_scan(self, page, text: str) -> bool:
        if len(re.sub(r"\s", "", text)) >= SCAN_TEXT_CHARS:
            return False
        try:
            return self.has_image(page, None, FORM_DEPTH)
        except Exception:
            # A guess that breaks on a damaged page, or runs out of work, means not a scan: the text already read stands.
            return False


def main() -> None:
    try:
        reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
        if reader.is_encrypted:
            print(json.dumps({"error": "encrypted"}))
            return
        pages = len(reader.pages)
        texts = [reader.pages[i].extract_text() or "" for i in range(min(pages, MAX_PAGES))]
        guess = ScanGuess()
        scanned = sum(1 for i, t in enumerate(texts) if guess.is_scan(reader.pages[i], t))
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
