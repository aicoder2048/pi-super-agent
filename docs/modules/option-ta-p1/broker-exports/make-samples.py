"""Write the fictional broker-export samples and the import results they should produce.

Run from the repo root: uv run --no-project python docs/modules/option-ta-p1/broker-exports/make-samples.py
Every name, number, id and amount here is made up. The expected files are derived from the same fictional table as the CSVs,
so they state what an importer should produce; they are not importer output.
"""
import csv
import io
import json
import pathlib
from datetime import date, timedelta
from decimal import Decimal as D

HERE = pathlib.Path(__file__).resolve().parent
JUNO = "EXAMPLEABC"
BROKER = "EXAMPLE BROKER LLC/EXB"

# Registered option-ta accounts and every way an export or a desk email names them.
ACCOUNTS = [
    {"account_ref": "JPM-NORT-4411", "broker": "jpm", "web_last4": "4411",
     "aliases": [{"kind": "jpm-export", "account_name": "NORTHWIND HARBOR LTD-MGN", "account_type": "Margin", "account_number": "...0101"},
                 {"kind": "email", "code": "NORTx4411"}, {"kind": "email", "code": "NORTxxxx"}]},
    {"account_ref": "JPM-BLUE-5522", "broker": "jpm", "web_last4": "5522",
     "aliases": [{"kind": "jpm-export", "account_name": "BLUEFIELD PARTNERS LIMITED - MGN", "account_type": "Margin", "account_number": "...0101"},
                 {"kind": "email", "code": "BLUEx5522"}, {"kind": "email", "code": "BLUExxxx"}]},
    {"account_ref": "JPM-BLUE-3301", "broker": "jpm", "web_last4": "3301",
     "aliases": [{"kind": "jpm-export", "account_name": "BLUEFIELD PARTNERS", "account_type": "Asset", "account_number": "...3301"},
                 {"kind": "email", "code": "BLUEx3301"}, {"kind": "email", "code": "BLUExxxx"}]},
    {"account_ref": "JPM-Personal-9902", "broker": "jpm", "web_last4": "9902",
     "aliases": [{"kind": "jpm-export", "account_name": "JORDAN SAMPLE", "account_type": "Asset", "account_number": "...9902"},
                 {"kind": "email", "code": "JORDx9902"}, {"kind": "email", "code": "JORDxxxx"}]},
    {"account_ref": "eTrade-Orbit-5150", "broker": "etrade", "web_last4": "5150",
     "aliases": [{"kind": "etrade-export", "account_label": "Orbit -5150"}]},
]
NORT, BLUE, BLUE_A, JORD = ("NORTHWIND HARBOR LTD-MGN", "Margin", "...0101"), ("BLUEFIELD PARTNERS LIMITED - MGN", "Margin", "...0101"), ("BLUEFIELD PARTNERS", "Asset", "...3301"), ("JORDAN SAMPLE", "Asset", "...9902")
NORT_IM, RIVER = ("NORTHWIND HARBOR CAPITAL", "Invt Mgmt", "...6610"), ("RIVERSTONE LLC", "Asset", "...2205")
REF = {a["aliases"][0].get("account_name"): a["account_ref"] for a in ACCOUNTS if a["broker"] == "jpm"}
ISSUER = {"DIA": "SPDR DOW JONES INDUSTRIAL AVERAGE ETF TRUST", "AAPL": "APPLE INC", "SPY": "SPDR S&P 500 ETF TRUST", "NVDA": "NVIDIA CORP"}


def d(s):
    return date.fromisoformat(s)


def next_bday(day, n=1):
    while n:
        day += timedelta(days=1)
        if day.weekday() < 5:
            n -= 1
    return day


def us(day, year4=True):
    return day.strftime("%m/%d/%Y" if year4 else "%m/%d/%y")


def money(x):
    return f"{x.quantize(D('0.01'))}"


def occ(und, expiry, right, strike):
    return f"{und}{expiry:%y%m%d}{right[0].upper()}{int(D(strike) * 1000):08d}"


def instrument(und, expiry, right, strike):
    return {"underlying": und, "option_symbol": occ(und, expiry, right, strike), "right": right, "strike": float(strike), "expiry": expiry.isoformat(), "multiplier": 100}


def fill_row(ref, side, und, expiry, right, strike, qty, price, trade, settle, order_id, commission, fees):
    inst = instrument(und, expiry, right, strike)
    key = f"{inst['option_symbol']}:{side}:{trade.isoformat()}:{ref}"
    return {"record_type": "FILL", "fill_id": f"{key}:cum{qty}", "order_key": key, "account_ref": ref, "side": side,
            "instrument": inst, "qty": qty, "partial_fill": False, "price": float(price), "limit": None, "trade_date": trade.isoformat(),
            "trade_time": None, "settle_date": settle.isoformat(), "executed_at": None, "order_id": order_id,
            "commission": commission, "fees": fees, "source": "broker-export"}


def event_row(ref, kind, und, expiry, right, strike, qty, event_date):
    inst = instrument(und, expiry, right, strike)
    eid = f"{inst['option_symbol']}:{kind}:{event_date.isoformat()}:{ref}"
    return {"record_type": "EVENT", "event_id": eid, "account_ref": ref, **{k: inst[k] for k in ("underlying", "option_symbol", "right", "strike", "expiry", "multiplier")},
            "qty": qty, "type": kind, "event_date": event_date.isoformat(), "trade_date": event_date.isoformat(), "source": "broker-export",
            # Every sample event shows no money and no commission: known-zero fees, not unknown (README §4).
            "commission": "0.0000", "fees": "0.0000"}


# ---------- JPM ----------
JPM_HEADER = ["Trade Date", "Post Date", "Settlement Date", "Account Name", "Account Number", "Account Type", "Type", "Description", "Cusip", "Ticker",
              "Security Type", "Local Currency", "Price USD", "Price Local", "Quantity", "Cost USD", "Cost Local", "G/L Short USD", "G/L Short Local",
              "G/L Long USDs", "G/L Long Local", "Amount USD", "Amount Local", "Income USD", "Income Local", "Balance", "Commissions USD",
              "Commissions Local", "Tran Code", "Tran Code Description", "Broker", "Check Number", "Tax Withheld"]
TRAN = {"Write option": ("166", "WR OPT SE FU"), "Buy back option": ("671", "BB LIQ OPT F"), "Expired option": ("668", "EXPR WRT OPT"),
        "Purchase": ("651", "PRCHSE ASSET"), "Sale": ("151", "SALE OF SEC")}
COMMISSION_PER_CONTRACT = D("3")
FEE_PER_CONTRACT = D("0.021")

# Option rows: (trade, post lag days, acct, type, und, expiry, right, strike, contracts, price, description style, juno seq, cusip)
JPM_OPTIONS = [
    ("2026-10-27", 0, NORT, "Write option", "DIA", "2026-10-30", "put", "470", 20, "1.15", "juno-end", 1, "46432F1AB"),
    ("2026-10-27", 0, BLUE, "Write option", "DIA", "2026-10-30", "put", "470", 30, "1.15", "juno-end", 2, "46432F1AB"),
    ("2026-10-27", 1, JORD, "Write option", "DIA", "2026-10-30", "put", "470", 2, "1.15", "right-then-juno", 3, "46432F1AB"),
    ("2026-10-26", 0, NORT, "Expired option", "DIA", "2026-10-23", "put", "475", 20, "0", "expired-repeat", None, "46432F1AC"),
    ("2026-10-26", 0, BLUE, "Expired option", "DIA", "2026-10-23", "put", "475", 30, "0", "expired-repeat", None, "46432F1AC"),
    ("2026-10-26", 0, JORD, "Expired option", "DIA", "2026-10-23", "put", "475", 2, "475", "expired-word", None, "46432F1AC"),
    ("2026-10-20", 0, NORT, "Buy back option", "AAPL", "2026-10-30", "put", "230", 10, "0.85", "juno-end", 1, "03783Q2AD"),
    ("2026-10-20", 0, BLUE, "Buy back option", "AAPL", "2026-10-30", "put", "230", 15, "0.85", "juno-end", 2, "03783Q2AD"),
    ("2026-10-19", 0, JORD, "Expired option", "AAPL", "2026-10-16", "put", "220", 1, "220", "expired-word", None, "03783Q2AE"),
    ("2026-10-16", 0, NORT, "Write option", "AAPL", "2026-11-20", "call", "270", 10, "2.4", "option-word", None, "03783Q2AF"),
    ("2026-10-16", 0, BLUE, "Write option", "AAPL", "2026-11-20", "call", "270", 15, "2.4", "option-word", None, "03783Q2AF"),
    ("2026-10-16", 3, BLUE_A, "Write option", "AAPL", "2026-11-20", "call", "270", 5, "2.4", "option-word-juno", 1, "03783Q2AF"),
    ("2026-10-07", 0, JORD, "Write option", "AAPL", "2026-10-16", "put", "220", 1, "1.3", "juno-first", 1, "03783Q2AE"),
    ("2026-10-05", 0, NORT, "Write option", "AAPL", "2026-10-23", "call", "255", 10, "1.8", "juno-end", 1, "03783Q2AG"),
]

# Non-option rows: (trade, settle lag, post lag, acct, type, description, cusip, ticker, price, qty, commission, fees, skip reason)
JPM_OTHER = [
    ("2026-10-30", 1, 0, NORT, "Sale", "MICROSOFT CORP @ 512.3400 51,234.00 SEC &/OR TAF FEE 1.28 EXAMPLE BROKER LLC EQUITIES TRADE DATE 10/30/26", "99990M104", "MSFT", "512.34", -100, "0", "1.28", "stock-trade-out-of-scope"),
    ("2026-10-30", 1, 3, BLUE_A, "Sale", "EXAMPLE PHARMA PLC - ADR @ 41.25 41,250.00 COMMISSION 123.75 SEC &/OR TAF 1.03 EXAMPLE BROKER LLC", "30212X106", "EXPH", "41.25", -1000, "124", "1.03", "stock-trade-out-of-scope"),
    ("2026-10-26", 0, 0, BLUE_A, "Purchase", "EXAMPLE PRIME MM FUND - PREMIER FUND 911 @ 1.0000 TRADE DATE 10/26/26 YIELD 4.01", "30213A207", "EXPXX", "1.0000", "12345.678", "0", "0", "money-market-fund"),
    ("2026-10-23", 1, 0, NORT, "Sale", "APPLE INC @ 255.0000 255,000.00 SEC &/OR TAF FEE 6.38 EXAMPLE BROKER LLC EQUITIES TRADE DATE 10/23/26", "99990A100", "AAPL", "255.0000", -1000, "0", "6.38", "possible-assignment"),
    ("2026-10-22", 1, 1, NORT_IM, "Purchase", "SAMPLE ENERGY CO SR NTS 5.1% 06/01/2033 DTD 06/01/2023 @ 101.250 EXAMPLE BROKER LLC TRADE DATE 10/22/26", "79588T9C1", "", "101.25", 100000, "0", "0", "bond"),
    ("2026-10-16", 0, 0, BLUE_A, "Sale", "EXAMPLE PRIME MM FUND - PREMIER FUND 911 @ 1.0000 TRADE DATE 10/16/26 YIELD 4.02", "30213A207", "EXPXX", "1.0000", "-2500.000", "0", "0", "money-market-fund"),
    ("2026-10-14", 1, 1, NORT_IM, "Purchase", "EXAMPLE CORP SR NTS 4.250% 03/15/2031 DTD 03/15/2024 @ 99.125 EXAMPLE BROKER LLC TRADE DATE 10/14/26", "30214B4D5", "", "99.125", 250000, "0", "0", "bond"),
    ("2026-10-09", 0, 0, JORD, "Purchase", "EXAMPLE US GOVT MM FUND - AGENCY FUND 3921 REINVEST @ 1.0000 EXAMPLE FUND", "30215C301", "EXGXX", "1.0000", "842.17", "0", "0", "money-market-fund"),
    ("2026-10-05", 0, 0, RIVER, "Purchase", "EXAMPLE PRIME MM FUND - PREMIER FUND 911 @ 1.0000 TRADE DATE 10/05/26 YIELD 4.03", "30213A207", "EXPXX", "1.0000", "5000.000", "0", "0", "money-market-fund"),
]


def jpm_description(style, und, expiry, right, strike, juno):
    r, ex, iss = right.upper(), us(expiry, False), ISSUER[und]
    return {
        "juno-end": f"{iss} {r} {ex} @ {strike}.0 JUNO: {juno}",
        "right-then-juno": f"{iss} {r} {ex} @ {strike} {r} JUNO: {juno}",
        "juno-first": f"{r} JUNO: {juno} {iss} {r} {ex} @ {strike}.0",
        "option-word": f"{iss} {r} {ex} @ {strike}.0 {r} OPTION",
        "option-word-juno": f"{iss} {r} {ex} @ {strike} {r} OPTION JUNO: {juno}",
        "expired-repeat": f"{iss} {r} {ex} @ {strike} {r} {und} {ex} {strike}",
        "expired-word": f"{iss} {r} {ex} @ {strike} EXPIRE UNEXERCISED {r}",
    }[style]


def jpm_rows():
    rows, expected, skipped, confirm = [], [], [], []
    for t, post_lag, acct, kind, und, exp, right, strike, n, price, style, seq, cusip in JPM_OPTIONS:
        trade, expiry, p = d(t), d(exp), D(price)
        juno = f"{JUNO}{trade:%Y%m%d}{seq:03d}" if seq else None
        desc = jpm_description(style, und, expiry, right, strike, juno)
        opened = (D("1.40") * n * 100).quantize(D("0.01"))
        if kind == "Expired option":
            settle, qty, amount, cost, gl, comm = trade, n, D(0), -opened, opened, D(0)
        else:
            settle = next_bday(trade)
            gross, comm, fees = p * n * 100, COMMISSION_PER_CONTRACT * n, (FEE_PER_CONTRACT * n).quantize(D("0.01"))
            if kind == "Write option":
                qty, amount = -n, gross - comm - fees
                cost, gl = amount, D(0)
            else:
                qty, amount = n, -(gross + comm + fees)
                cost, gl = opened, opened + amount
        row = {"Trade Date": us(trade), "Post Date": us(trade + timedelta(days=post_lag)), "Settlement Date": us(settle),
               "Account Name": acct[0], "Account Number": acct[2], "Account Type": acct[1], "Type": kind, "Description": desc, "Cusip": cusip,
               "Ticker": und, "Local Currency": "USD", "Price USD": price, "Price Local": price, "Quantity": str(qty), "Cost USD": money(cost),
               "Cost Local": money(cost), "G/L Short USD": money(gl) if gl else "0", "G/L Short Local": money(gl) if gl else "0", "G/L Long USDs": "0",
               "G/L Long Local": "0", "Amount USD": money(amount) if amount else "0", "Amount Local": money(amount) if amount else "0",
               "Commissions USD": str(comm), "Commissions Local": str(comm), "Broker": BROKER}
        rows.append(row)
        ref = REF[acct[0]]
        if kind == "Expired option":
            expected.append((trade, event_row(ref, "EXPIRE", und, expiry, right, strike, n, expiry)))
        else:
            side = "STO" if kind == "Write option" else "BTC"
            expected.append((trade, fill_row(ref, side, und, expiry, right, strike, n, p, trade, settle, juno, money(comm), money(fees))))
    for t, settle_lag, post_lag, acct, kind, desc, cusip, ticker, price, qty, comm, fees, reason in JPM_OTHER:
        trade = d(t)
        q, p = D(str(qty)), D(price)
        gross = (abs(q) * p * (D("0.01") if reason == "bond" else 1)).quantize(D("0.01"))
        amount = gross - D(comm) - D(fees) if kind == "Sale" else -(gross + D(comm) + D(fees))
        if reason == "money-market-fund":
            amount = gross if kind == "Sale" else -gross
        cost = -amount
        rows.append({"Trade Date": us(trade), "Post Date": us(trade + timedelta(days=post_lag)), "Settlement Date": us(next_bday(trade, settle_lag) if settle_lag else trade),
                     "Account Name": acct[0], "Account Number": acct[2], "Account Type": acct[1], "Type": kind, "Description": desc, "Cusip": cusip,
                     "Ticker": ticker, "Local Currency": "USD", "Price USD": price, "Price Local": price, "Quantity": str(qty),
                     "Cost USD": money(cost), "Cost Local": money(cost), "G/L Short USD": "0", "G/L Short Local": "0", "G/L Long USDs": "0", "G/L Long Local": "0",
                     "Amount USD": money(amount), "Amount Local": money(amount), "Commissions USD": comm, "Commissions Local": comm,
                     "Broker": "" if "AGENCY" in desc else BROKER})
    order = sorted(range(len(rows)), key=lambda i: (rows[i]["Trade Date"][6:] + rows[i]["Trade Date"][:5], -i), reverse=True)
    rows = [rows[i] for i in order]
    for line, row in enumerate(rows, start=2):
        row.update({"Security Type": "", "Income USD": "", "Income Local": "", "Balance": "", "Check Number": "0", "Tax Withheld": "",
                    "Tran Code": TRAN[row["Type"]][0], "Tran Code Description": TRAN[row["Type"]][1]})
        other = next((o for o in JPM_OTHER if o[5] == row["Description"]), None)
        if other is None:
            continue
        reason = other[12]
        if reason == "possible-assignment":
            confirm.append({"line": line, "type": row["Type"], "account_ref": REF[row["Account Name"]], "reason": "possible-assignment",
                            "detail": "股票卖出：同账户有一张 AAPL 2026-10-23 255 call 的卖开在导出里，成交日是到期日，价格等于行权价，股数 = 张数 × 100，导出里没有这张 call 的到期行。像是被指派，导出里指派的写法还没见过，问使用者"})
        else:
            skipped.append({"line": line, "type": row["Type"], "account": f"{row['Account Name']} | {row['Account Type']} | {row['Account Number']}", "reason": reason})
    fills = []
    for line, row in enumerate(rows, start=2):
        match = [e for (t, e) in expected if row["Type"] in ("Write option", "Buy back option", "Expired option")
                 and REF[row["Account Name"]] == e["account_ref"] and us(t) == row["Trade Date"]
                 and e.get("option_symbol", e.get("instrument", {}).get("option_symbol")) in occ_of_row(row)]
        if match:
            fills.append({"line": line, **match[0]})
    return rows, {"fills": fills, "skipped": skipped, "needs_confirmation": confirm}


def occ_of_row(row):
    for und, exp, right, strike in {(o[4], o[5], o[6], o[7]) for o in JPM_OPTIONS}:
        if row["Ticker"] == und and f"{right.upper()} {us(d(exp), False)} @ {strike}" in row["Description"]:
            return [occ(und, d(exp), right, strike)]
    return []


def write_jpm():
    rows, expected = jpm_rows()
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=JPM_HEADER, lineterminator="\r\n")
    w.writeheader()
    w.writerows(rows)
    (HERE / "jpm-sample.csv").write_bytes(b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8"))
    return expected


# ---------- eTrade ----------
ET_HEADER = "Activity/Trade Date,Transaction Date,Settlement Date,Activity Type,Description,Symbol,Cusip,Quantity #,Price $,Amount $,Commission,Category,Note"
ET_REF = "eTrade-Orbit-5150"
# (trade, settle, activity, und or stock name, expiry, right, strike, qty, price, commission)
ET_ROWS = [
    ("2026-10-19", "2026-10-16", "Option Assigned", "NVDA", "2026-10-16", "call", "190", 2, None, "0.0"),
    ("2026-10-19", "2026-10-19", "Sold", "NVDA", None, None, None, -200, "190.0", "0.32"),
    ("2026-10-16", "2026-10-19", "Sold Short", "SPY", "2026-10-23", "put", "575", -5, "1.85", "3.30"),
    ("2026-10-14", "2026-10-15", "Bought To Cover", "SPY", "2026-10-16", "put", "580", 3, "0.45", "1.98"),
    ("2026-10-13", "2026-10-14", "Sold", "MSFT", None, None, None, -10, "508.2", "0.05"),
    ("2026-10-09", "2026-10-12", "Sold Short", "SPY", "2026-10-16", "put", "580", -3, "2.1", "1.98"),
    ("2026-10-02", "2026-10-05", "Sold Short", "NVDA", "2026-10-16", "call", "190", -2, "3.4", "1.32"),
]
STOCK_NAME = {"NVDA": "NVIDIA CORP", "MSFT": "MICROSOFT CORP"}
DISCLAIMERS = [
    '"For all accounts, the activity shown here is provided for your convenience only. It is not an official record, and your account statement and trade confirmations govern; amounts may change before settlement."',
    '"The information provided with this download (""Data"") is fictional sample text made for a test fixture. It does not come from any broker, it is not advice, and it must not be relied on."',
    "EXAMPLE TRADING from Example Holdings is a fictional name used only in this sample. Nothing here is an offer or a solicitation of any security; this sentence only gives the line its shape.",
    '"Under the Sample Deposit Program, cash may be swept to example banks; this paragraph is fictional and exists only so the file ends with the same kind of long quoted disclaimer lines as a real export."',
]


def write_etrade():
    lines, fills, skipped, total = [], [], [], D(0)
    assigned = {}
    for i, (t, s, act, und, exp, right, strike, qty, price, comm) in enumerate(ET_ROWS):
        trade, settle, c = d(t), d(s), D(comm)
        line_no = 8 + i
        if exp:
            expiry = d(exp)
            desc = f"{right.upper():<5}{und:<7}{us(expiry, False)}   {D(strike):.3f}"
            mult = 100
        else:
            desc, mult = STOCK_NAME[und], 1
        if act == "Option Assigned":
            amount = D(0)
        else:
            gross = abs(qty) * D(price) * mult
            amount = gross - c if qty < 0 else -(gross + c)
        total += amount
        lines.append(",".join([us(trade), us(trade), us(settle), act, desc, und, "--", f"{D(qty):.1f}", price or "", f"{amount}" if amount else "0.0", comm, "--", "--"]))
        if act in ("Sold Short", "Bought To Cover"):
            side = "STO" if act == "Sold Short" else "BTC"
            fills.append({"line": line_no, **fill_row(ET_REF, side, und, expiry, right, strike, abs(qty), D(price), trade, settle, None, money(c), "0.0000")})
        elif act == "Option Assigned":
            # Assigned at expiration (reported within a few days after expiry): the event date is the expiry, like EXPIRE; early assignment keeps its own date.
            event_date = expiry if expiry <= trade and (trade - expiry).days <= 4 else trade
            ev = event_row(ET_REF, "ASSIGNED", und, expiry, right, strike, qty, event_date)
            assigned[und] = (ev, D(strike), qty)
            fills.append({"line": line_no, **ev})
        elif act == "Sold" and und in assigned and abs(qty) == assigned[und][2] * 100 and D(price) == assigned[und][1]:
            ev = assigned[und][0]
            key = f"{und}:SELL:{trade.isoformat()}:{ET_REF}"
            fills.append({"line": line_no, "record_type": "FILL", "fill_id": f"{key}:cum{abs(qty)}", "order_key": key,
                          "account_ref": ET_REF, "side": "SELL", "instrument": {"underlying": und, "option_symbol": None, "right": None, "strike": None, "expiry": None, "multiplier": 1},
                          "qty": abs(qty), "partial_fill": False, "price": float(price), "limit": None, "trade_date": trade.isoformat(), "trade_time": None,
                          "settle_date": settle.isoformat(), "executed_at": None, "order_id": None, "commission": money(c), "fees": "0.0000",
                          "source": "broker-export", "caused_by_event": ev["event_id"]})
        else:
            skipped.append({"line": line_no, "type": act, "reason": "stock-trade-out-of-scope"})
    head = ["Trade Activity Activity Types", "", "Account Activity for  Orbit -5150 from LAST 30 Days", "", f"Total:,{total}", "", ET_HEADER]
    tail = ["", "", ""] + [x for p in DISCLAIMERS for x in (p, "")] + [""]
    (HERE / "etrade-sample.csv").write_bytes(("\r\n".join(head + lines + tail)).encode("utf-8"))
    return {"fills": fills, "skipped": skipped, "needs_confirmation": []}


def dump(name, obj):
    (HERE / name).write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(name)


def existing_fill(ref, side, symbol, qty, price, trade, settle, source):
    key = f"{symbol}:{side}:{trade}:{ref}"
    return {"record_type": "FILL", "fill_id": f"{key}:cum{qty}", "order_key": key, "account_ref": ref, "side": side, "option_symbol": symbol,
            "qty": qty, "price": price, "trade_date": trade, "settle_date": settle, "commission": None, "fees": None, "order_id": None, "source": source}


def reconcile(jpm):
    by_line = {f["line"]: f for f in jpm["fills"]}
    email_nort = existing_fill("NORTxxxx", "STO", "DIA261030P00470000", 20, "1.1500", "2026-10-27", None, "broker-email")
    manual_blue = existing_fill("JPM-BLUE-5522", "STO", "DIA261030P00470000", 30, "1.1000", "2026-10-27", None, "manual")
    email_blue = existing_fill("BLUExxxx", "STO", "AAPL261120C00270000", 5, "2.4000", "2026-10-16", None, "broker-email")
    pending = existing_fill("JPM-Personal-9902", "STO", "AAPL261106P00215000", 1, "0.9500", "2026-10-30", "2026-11-02", "manual")
    missing = existing_fill("JPM-Personal-9902", "STO", "AAPL261030P00225000", 1, "1.0500", "2026-10-21", "2026-10-22", "manual")
    old = existing_fill("JPM-NORT-4411", "STO", "AAPL261030P00230000", 10, "1.4000", "2026-09-28", "2026-09-29", "manual")
    expired = {k: by_line[7][k] for k in ("record_type", "event_id", "account_ref", "option_symbol", "qty", "type", "event_date", "trade_date")} | {"source": "manual"}
    imported = {k: by_line[13][k] for k in ("record_type", "fill_id", "order_key", "account_ref", "side", "qty", "trade_date", "settle_date", "commission", "fees", "order_id", "source")} | {"option_symbol": by_line[13]["instrument"]["option_symbol"], "price": "0.8500"}
    existing = [email_nort, manual_blue, email_blue, pending, missing, old, expired, imported]
    reversal = {"record_type": "REVERSAL", "fill_id": f"{email_nort['fill_id']}:reversed-by-export", "reversal_of": email_nort["fill_id"], "trade_date": "2026-10-27", "source": "broker-export"}
    held = {5: "conflict", 18: "account-unconfirmed"}
    known = {7: "already-recorded", 13: "already-recorded", 4: "enrich"}
    lines = []
    for line, f in sorted(by_line.items()):
        lines.append({"line": line, "id": f.get("fill_id") or f["event_id"], "action": held.get(line) or known.get(line) or "add"})
    write = [reversal["fill_id"], by_line[4]["fill_id"]] + [x["id"] for x in lines if x["action"] == "add"]
    return {
        "input": {"file": "jpm-sample.csv", "imported_at": "2026-11-02", "existing": existing},
        "expected": {
            "write": write,
            "reversal_example": reversal,
            "lines": lines,
            "existing": [
                {"key": email_nort["fill_id"], "action": "enrich", "by_line": 4, "fills_in": ["account_ref", "settle_date", "order_id", "commission", "fees"]},
                {"key": manual_blue["fill_id"], "action": "conflict", "by_line": 5, "detail": "price 1.1000 vs export 1.15"},
                {"key": email_blue["fill_id"], "action": "account-unconfirmed", "candidates": ["JPM-BLUE-5522", "JPM-BLUE-3301"], "suggested": "JPM-BLUE-3301", "by_line": 18},
                {"key": pending["fill_id"], "action": "pending-settlement"},
                {"key": missing["fill_id"], "action": "missing-from-export"},
                {"key": old["fill_id"], "action": "outside-export-window"},
                {"key": expired["event_id"], "action": "already-recorded", "by_line": 7},
                {"key": imported["fill_id"], "action": "already-recorded", "by_line": 13},
            ],
            "ask": [
                "line 5 / manual JPM-BLUE-5522 DIA 2026-10-30 470 put STO 2026-10-27 x30: price 1.10 recorded, export says 1.15",
                "BLUExxxx AAPL 2026-11-20 270 call STO 2026-10-16 x5: JPM-BLUE-5522 or JPM-BLUE-3301? export line 18 matches JPM-BLUE-3301",
                "manual JPM-Personal-9902 AAPL 2026-10-30 225 put STO 2026-10-21 x1: settled 2026-10-22 but not in the export",
                "line 11 possible assignment: NORT AAPL 255 call expiring 2026-10-23, 1000 shares sold at 255",
            ],
            "rerun": "importing the same file again with existing + write yields write = []",
        },
    }


jpm = write_jpm()
dump("jpm-sample.expected.json", jpm)
dump("etrade-sample.expected.json", write_etrade())
dump("jpm-sample.reconcile.json", reconcile(jpm))
dump("account-aliases.sample.json", {"accounts": ACCOUNTS, "no_option_accounts": [
    {"account_name": NORT_IM[0], "account_type": NORT_IM[1], "account_number": NORT_IM[2]},
    {"account_name": RIVER[0], "account_type": RIVER[1], "account_number": RIVER[2]}]})
