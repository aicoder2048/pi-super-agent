"""Writes the synthetic ta.sqlite that the cases of stock-ta's exported tools read.

The prices are made up (a trend plus two waves), never a real quote. ta's own scanner fills
the database from a fake market source, so the file has the schema and rows the pinned ta
writes. Rerun after a change to the ta pin in py/uv.lock, then update the cases' `expect`. Run it with the
Python of the venv that `just module setup stock-ta` installed:

    ~/.pi-super-agent/modules-data/stock-ta/files/venv-<lock>/bin/python tests/fixtures/stock-ta/make-ta-fixture.py
"""

import math
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from ta.calendar import NEW_YORK, TradingCalendar
from ta.models import Bar
from ta.scanner import Scanner
from ta.storage import Store

OUT = Path(__file__).resolve().parents[3] / "docs/modules/examples/stock-ta/tools/structure/fixtures/data/files/ta/ta.sqlite"
NOW_MS = int(datetime(2026, 11, 13, 22, 0, tzinfo=UTC).timestamp() * 1000)
SERIES = {"NVDA": (120.0, 0.0009, 0.10), "QQQ": (480.0, 0.0005, 0.05), "SPY": (560.0, 0.0004, 0.04)}


class FakeMarket:
    def __init__(self):
        self.calendar = TradingCalendar()

    def validate_symbol(self, symbol):
        return {"symbol": symbol, "ticker": symbol, "market": "stocks", "locale": "us", "currency_name": "usd", "type": "ETF" if symbol in ("QQQ", "SPY") else "CS", "primary_exchange": "XNAS"}

    def get_bars(self, symbol, timeframe, start_ms, end_ms):
        if timeframe != "1d":
            return []
        base, drift, swing = SERIES[symbol]
        first = datetime.fromtimestamp(start_ms / 1000, UTC).date().isoformat()
        last = datetime.fromtimestamp(end_ms / 1000, UTC).date().isoformat()
        bars = []
        for i, session in enumerate(self.calendar.sessions("2024-01-02", last)):
            if session["date"] < first or session["close_ms"] > end_ms:
                continue
            close = base * (1 + drift) ** i * (1 + swing * math.sin(i / 17)) * (1 + 0.02 * math.sin(i / 3.3))
            opening = close * (1 - 0.006 * math.cos(i / 2.1))
            high = max(opening, close) * 1.008
            low = min(opening, close) * 0.992
            start = int(datetime.fromisoformat(session["date"]).replace(tzinfo=NEW_YORK).timestamp() * 1000)
            bars.append(Bar(start, session["close_ms"], session["date"], round(opening, 2), round(high, 2), round(low, 2), round(close, 2), float(30_000_000 + 5_000_000 * math.sin(i / 5)), None, True))
        return bars

    def get_dividends(self, symbol, start_date):
        return []


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    for path in (OUT, Path(str(OUT) + ".scan.lock")):
        path.unlink(missing_ok=True)
    store = Store(OUT)
    try:
        result = Scanner(store, FakeMarket()).scan("daily", NOW_MS, ["NVDA"])
    finally:
        store.close()
    Path(str(OUT) + ".scan.lock").unlink(missing_ok=True)
    if result.get("errors"):
        sys.exit(f"the scan reported errors: {result['errors']}")
    db = sqlite3.connect(OUT)
    db.execute("UPDATE signals SET read = 0")
    db.execute("UPDATE scans SET duration_ms = 0")
    db.commit()
    db.execute("VACUUM")
    db.close()
    print(f"{OUT}: {len(result['new_signals'])} signals, {OUT.stat().st_size} bytes")


main()
