# 用法：python3 -I make-samples.py <probe.sh 的输出目录> <samples 目录> "<录制时间说明>"
# 合约代码和日期是 2026-11-17 那次的，过了到期日要先改 probe.sh 和这里的代码。
import json, sys, os
raw, out, AT = sys.argv[1], sys.argv[2], sys.argv[3]
def load(n): return json.load(open(os.path.join(raw, n + ".json")))
def save(name, request, body, note):
    doc = {"recorded": {"at": AT, "request": "GET https://api.massive.com" + request, "status": 200, "note": note}, "body": body}
    with open(os.path.join(out, name + ".json"), "w") as f: json.dump(doc, f, ensure_ascii=False, indent=1); f.write("\n")
def pick(rows, tickers): return [r for t in tickers for r in rows if (r.get("details", r).get("ticker")) == t]

c = load("contracts_spy_puts")
save("contracts-spy-puts", "/v3/reference/options/contracts?underlying_ticker=SPY&expiration_date=2026-11-20&contract_type=put&strike_price.gte=725&strike_price.lte=735&limit=50",
     {**c, "results": pick(c["results"], ["O:B1SPY261120P00730000", "O:SPY261120P00730000", "O:SPY261120P00731000"])},
     "原应答 results 有 14 行（3 行二元期权 O:B1...，11 行标准期权），这里留 1 行二元 + 2 行标准；本次没有 next_url")
c = load("contracts_spy")
save("contracts-spy-page1-binary", "/v3/reference/options/contracts?underlying_ticker=SPY&expiration_date=2026-11-20&limit=10",
     {**c, "results": c["results"][:2]}, "默认按 ticker 升序，第一页全是二元期权 O:B1...；留 2 行和原样的 next_url（游标里只有查询条件，不含 key）")
save("contracts-spy-expired", "/v3/reference/options/contracts?underlying_ticker=SPY&expiration_date=2026-10-30&contract_type=put&strike_price=680&expired=true",
     load("contracts_expired"), "已到期合约要带 expired=true 才查得到；原样")
s = load("chain_spy_puts")
save("chain-spy-puts-filtered", "/v3/snapshot/options/SPY?expiration_date=2026-11-20&contract_type=put&strike_price.gte=720&strike_price.lte=740&limit=50",
     {**s, "results": pick(s["results"], ["O:B1SPY261120P00730000", "O:SPY261120P00725000", "O:SPY261120P00730000", "O:SPY261120P00735000"])},
     "原应答 26 行（二元 5 行 + 标准 21 行），没有 next_url；留 1 行二元（没有 greeks、IV、break_even，day 和 last_trade 是空对象）+ 3 行标准")
n = load("chain_nvda")
rows = n["results"]
noiv = [r for r in rows if r["details"]["exercise_style"] == "american" and "implied_volatility" not in r][:2]
ok = [r for r in rows if r["details"]["ticker"].startswith("O:NVDA261118P0015") and "implied_volatility" in r][:2]
binr = [r for r in rows if r["details"]["ticker"].startswith("O:B")][:1]
save("chain-nvda-missing-greeks", "/v3/snapshot/options/NVDA?limit=250",
     {**n, "results": ok + noiv + binr},
     "原应答 250 行（两个到期日混在一页，按 ticker 排序）且带 next_url；留 2 行正常、2 行 greeks 为空对象且没有 implied_volatility（深度价内或极度价外的近月合约）、1 行二元")
save("chain-single-contract", "/v3/snapshot/options/SPY/O:SPY261120P00730000", load("single_spy"), "单合约快照，results 是对象不是数组；原样")
save("aggs-prev-option", "/v2/aggs/ticker/O:SPY261120P00730000/prev", load("prev_opt"), "期权合约的上一交易日日线；原样")
save("aggs-prev-underlying", "/v2/aggs/ticker/SPY/prev", load("prev_spy"), "正股上一交易日日线，用来和快照里的 underlying_asset.price 对照；原样")
r = load("range_expired")
save("aggs-range-expired-option", "/v2/aggs/ticker/O:SPY261030P00680000/range/1/day/2026-09-01/2026-10-30?limit=100",
     {**r, "results": r["results"][:4] + r["results"][-2:]}, "已到期合约的日线照样能取；原应答 43 根，留头 4 根尾 2 根，resultsCount 仍是原值")
r = load("range_older")
save("aggs-range-2021-option", "/v2/aggs/ticker/O:SPY220121P00460000/range/1/day/2021-12-01/2022-01-21?limit=100",
     {**r, "results": r["results"][:3]}, "2022-01 到期的合约也取得到，说明期权日线至少回溯到 2021-12；原应答 36 根，留 3 根")
d = load("dividends_spy")
save("dividends-spy", "/v3/reference/dividends?ticker=SPY&limit=3", {**d, "results": d["results"][:2]}, "默认按除息日倒序；原 3 行留 2 行")
save("dividends-spy-future-empty", "/v3/reference/dividends?ticker=SPY&ex_dividend_date.gte=2026-11-17&limit=5", load("dividends_spy_future"), "还没宣布的除息查不到：results 为空数组；原样")
q = load("quotes_hist")
save("quotes-option", "/v3/quotes/O:SPY261120P00730000?limit=2", q, "逐笔报价历史，这个 key 能读；原样（第一版不用，留作证据）")
