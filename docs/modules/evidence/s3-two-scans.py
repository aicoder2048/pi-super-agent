"""Runs ta's real scanner twice on a fake market: day 1, then day 2 just under 24 h later, as the hourly feed can.

    <venv>/bin/python -I s3-two-scans.py <db> <day1 ms> <day2 ms>
"""
import sys
from datetime import UTC, datetime
from pathlib import Path

from ta.calendar import TradingCalendar
from ta.models import Bar
from ta.scanner import Scanner
from ta.storage import Store

DAY_MS = 86_400_000
db, day1, day2 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
calendar = TradingCalendar()
iso = lambda ms: datetime.fromtimestamp(ms / 1000, UTC).isoformat()


class Market:
    def validate_symbol(self, symbol):
        return {"ticker": symbol}

    def get_dividends(self, symbol, start_date):
        return []

    def get_bars(self, symbol, timeframe, start_ms, end_ms):
        bars = []
        for s in calendar.sessions(iso(start_ms - DAY_MS)[:10], iso(end_ms)[:10]):
            if s["open_ms"] < start_ms or s["close_ms"] > end_ms:
                continue
            # A bar refetched on day 2 must equal day 1's copy, or ta drops the whole cache.
            n = s["close_ms"] // DAY_MS
            price = 100 + n % 40 + n % 7
            bars.append(Bar(s["open_ms"], s["close_ms"], s["date"], price, price + 2, price - 2, price + 1, 1e6))
        return bars


store = Store(Path(db))
for now in (day1, day2):
    result = Scanner(store, Market(), calendar).scan("daily", now, ["NVDA"])
    print(f"scan at {iso(now)}: errors {result.get('errors')}")
for row in store.connection.execute("SELECT symbol, synced_ms FROM dividend_sync ORDER BY symbol"):
    print(f"dividend_sync {row['symbol']} {iso(row['synced_ms'])}")
newest = store.connection.execute("SELECT max(end_ms) AS e FROM bars WHERE symbol = 'NVDA' AND timeframe = '1d'").fetchone()["e"]
print(f"NVDA newest daily bar ends {iso(newest)}")
