#!/bin/bash
# 重跑 P1 的接口实测：把原始应答和响应头写进 $1（默认临时目录），再用 make-samples.py 裁成 samples/。
# key 从 ~/.pi-super-agent/config.json 的 secretsFile 读，走 Authorization 头，不进 URL、不打印。
set -euo pipefail
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT"
SECRETS=$(python3 -I -c 'import json,os;print(json.load(open(os.path.expanduser("~/.pi-super-agent/config.json")))["secretsFile"])')
KEY=$(grep '^POLYGON_API_KEY=' "$SECRETS" | head -1 | cut -d= -f2- | tr -d "\"' ")
[ -n "$KEY" ] || { echo "secretsFile 里没有 POLYGON_API_KEY" >&2; exit 1; }
BASE=https://api.massive.com
get() { printf '%-22s ' "$1"; curl -sS -D "$OUT/$1.headers" -o "$OUT/$1.json" -w '%{http_code} %{size_download}B\n' -H "Authorization: Bearer $KEY" "$BASE$2"; }
get contracts_spy '/v3/reference/options/contracts?underlying_ticker=SPY&expiration_date=2026-11-20&limit=10'
get contracts_spy_puts '/v3/reference/options/contracts?underlying_ticker=SPY&expiration_date=2026-11-20&contract_type=put&strike_price.gte=725&strike_price.lte=735&limit=50'
get contracts_expired '/v3/reference/options/contracts?underlying_ticker=SPY&expiration_date=2026-10-30&contract_type=put&strike_price=680&expired=true'
get chain_spy '/v3/snapshot/options/SPY?expiration_date=2026-11-20&limit=250'
get chain_spy_puts '/v3/snapshot/options/SPY?expiration_date=2026-11-20&contract_type=put&strike_price.gte=720&strike_price.lte=740&limit=50'
get chain_spy_asof '/v3/snapshot/options/SPY?expiration_date=2026-11-20&contract_type=put&strike_price.gte=725&strike_price.lte=735&as=2026-11-10'
get chain_nvda '/v3/snapshot/options/NVDA?limit=250'
get single_spy '/v3/snapshot/options/SPY/O:SPY261120P00730000'
get prev_opt '/v2/aggs/ticker/O:SPY261120P00730000/prev'
get prev_spy '/v2/aggs/ticker/SPY/prev'
get range_expired '/v2/aggs/ticker/O:SPY261030P00680000/range/1/day/2026-09-01/2026-10-30?limit=100'
get range_older '/v2/aggs/ticker/O:SPY220121P00460000/range/1/day/2021-12-01/2022-01-21?limit=100'
get dividends_spy '/v3/reference/dividends?ticker=SPY&limit=3'
get dividends_spy_future '/v3/reference/dividends?ticker=SPY&ex_dividend_date.gte=2026-11-17&limit=5'
get quotes_hist '/v3/quotes/O:SPY261120P00730000?limit=2'
if grep -l -F "$KEY" "$OUT"/* >/dev/null 2>&1; then echo "应答里出现了 key，别用这些文件" >&2; exit 1; fi
echo "原始应答在 $OUT"
