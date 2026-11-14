"""Run after pdf_text.py, in its own process with its own time and memory limits: argv is how many scans make the
PDF one, then the nearly empty pages to check. Prints {"scan": true} when that many of them hold an image."""

import io
import json
import sys

from pypdf import PdfReader
from pypdf.generic import IndirectObject

# Merged, optimized and print-to-PDF files often wrap the page image in a Form XObject.
FORM_DEPTH = 4


def dictionary(value):
    return value.get_object() if value is not None else {}


class ScanGuess:
    def __init__(self) -> None:
        # Whether an /XObject table holds an image within a depth, keyed by the first indirect object it lives in:
        # pages and Forms may share one table.
        self.known: dict[tuple[int, int, int], bool] = {}

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
        for ref in table.values():
            xobject = dictionary(ref)
            subtype = xobject.get("/Subtype")
            if subtype == "/Image":
                return True
            if subtype == "/Form" and depth > 0 and self.has_image(xobject, ref, depth - 1):
                return True
        return False


def main() -> None:
    need, *pages = (int(arg) for arg in sys.argv[1:])
    reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
    guess = ScanGuess()
    found = 0
    for i in pages:
        found += guess.has_image(reader.pages[i], None, FORM_DEPTH)
        if found >= need:
            break
    print(json.dumps({"scan": found >= need}))


main()
