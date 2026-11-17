"""Turn each fictional sample .eml here into a `fills` feed fixture: the Letter the mail connector would hand over.

Run from the repo root: uv run --no-project python docs/modules/option-ta-p1/mail-samples/make-fills-fixtures.py
`from` is the fictional desk address, as in production where the desk's reply lands in Gmail directly (README section 1).
"""
import email
import json
import pathlib
from email import policy
from datetime import timezone
from email.utils import parsedate_to_datetime

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parents[1] / "examples" / "option-ta" / "feeds" / "fills" / "fixtures"
DESK = {"name": "EXB Desk", "address": "exb.desk@example.net"}


def text_of(message, mime_type):
    for part in message.walk():
        if part.get_content_type() == mime_type and part.get_filename() is None:
            return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8")
    raise SystemExit(f"no {mime_type} part")


for path in sorted(HERE.glob("*.eml")):
    message = email.message_from_bytes(path.read_bytes(), policy=policy.default)
    letter = {
        "id": f"sample-{path.stem}",
        "threadId": f"thread-{path.stem}",
        "messageIdHeader": str(message["Message-ID"]),
        "from": DESK,
        "replyTo": "",
        "subject": str(message["Subject"]),
        "date": parsedate_to_datetime(str(message["Date"])).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "snippet": "",
        "body": text_of(message, "text/plain"),
        "html": text_of(message, "text/html"),
        "attachments": [],
    }
    (OUT / f"{path.stem}.json").write_text(json.dumps({"input": {"items": [letter]}}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(path.stem)
