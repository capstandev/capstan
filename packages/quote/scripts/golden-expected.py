"""Independent expected values for the quote golden test (R1), written with Python's decimal module.

Run from the repo root:  python3 -I packages/quote/scripts/golden-expected.py
Reads test/fixtures/books/*.json and writes test/fixtures/golden-expected.json. The scenario per book:
  side = buy for even indexes, sell for odd; size = the first three levels on that side; market order with the
  default 50 bps protective limit; hold 8 h at a funding rate of 0.0000125 per hour; base fee tiers, no lock tier,
  HIP-3 builder on (DECISIONS #31). Venue rules restated here on purpose, in another language, so the test is not circular.
"""
import json
import os
from decimal import Decimal as D, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, getcontext

getcontext().prec = 100
HERE = os.path.dirname(os.path.abspath(__file__))
BOOKS = os.path.join(HERE, "..", "test", "fixtures", "books")
OUT = os.path.join(HERE, "..", "test", "fixtures", "golden-expected.json")
SETS = ["hyperliquid-core", "hyperliquid-xyz", "lighter-mainnet", "lighter-rh", "aster"]
BPS = 50
RATE = D("0.0000125")
HOLD = D(8)
Q18 = D("1e-18")


def s(x):
    """Decimal to the engine's string form: plain, trailing zeros removed."""
    t = format(x.normalize(), "f")
    if "." in t:
        t = t.rstrip("0").rstrip(".")
    return "0" if t in ("-0", "") else t


def unit(dp):
    return D(1).scaleb(-dp)


def bound(ref, side):
    f = D(10000 + BPS) if side == "buy" else D(10000 - BPS)
    return (ref * f / D(10000)).quantize(Q18, rounding=ROUND_HALF_EVEN)


def hl_bound(ref, side):
    """adapter-hyperliquid protectiveLimit: truncate at 18 decimals, then half-even to 12."""
    f = D(10000 + BPS) if side == "buy" else D(10000 - BPS)
    return (ref * f / D(10000)).quantize(Q18, rounding=ROUND_FLOOR).quantize(D("1e-12"), rounding=ROUND_HALF_EVEN)


def floor_step(x, step):
    return (x / step).to_integral_value(rounding=ROUND_FLOOR) * step


def round_step(x, step, side):
    r = ROUND_FLOOR if side == "buy" else ROUND_CEILING
    return (x / step).to_integral_value(rounding=r) * step


def hl_allowed(px_s, szd):
    max_dec = 6 - szd
    i, _, f = px_s.partition(".")
    ip = i.lstrip("0")
    if ip:
        sig = max(0, 5 - len(ip))
    else:
        sig = (len(f) - len(f.lstrip("0"))) + 5
    return max(0, min(max_dec, sig))


def hl_format(px, szd, side):
    v = px
    if v == v.to_integral_value():
        return v
    for _ in range(4):
        dec = hl_allowed(s(v), szd)
        r = round_step(v, unit(dec), side)
        if r == r.to_integral_value():
            return r
        rs = s(r)
        have = len(rs.split(".")[1]) if "." in rs else 0
        if have <= hl_allowed(rs, szd):
            return r
        v = r
    raise ValueError("no grid")


def bps4(x):
    v = x.quantize(D("0.0001"), rounding=ROUND_HALF_EVEN)
    return float(v) if v != 0 else 0.0


def scenario(set_name, i, rec):
    side = "buy" if i % 2 == 0 else "sell"
    book = rec["book"]
    levels = book["asks"] if side == "buy" else book["bids"]
    meta = rec["meta"]
    if not levels:
        return {"marketId": rec["marketId"], "side": side, "status": "insufficient_depth"}
    size = sum(D(sz) for _, sz in levels[:3])
    best = D(levels[0][0])
    if set_name.startswith("hyperliquid"):
        szd = int(meta["szDecimals"])
        size = floor_step(size, unit(szd))
        mid = ((D(book["bids"][0][0]) + D(book["asks"][0][0])) / 2).quantize(D("1e-12"), rounding=ROUND_HALF_EVEN)
        limit = hl_format(hl_bound(mid, side), szd, side)
        venue_fee = D("4.5")
        if meta.get("dex"):
            scale = D(str(meta.get("deployerFeeScale") or "1.0"))
            venue_fee = D("4.5") * (max(D(1), scale) + scale) * (D("0.1") if meta.get("growthMode") == "enabled" else D(1))
        builder = D(2)
    elif set_name == "aster":
        size = floor_step(size, D(meta["stepSize"]))
        limit = round_step(bound(best, side), D(meta["tickSize"]), side)
        venue_fee, builder = D("3.5"), D(2)
    else:
        size = floor_step(size, unit(int(meta["sizeDecimals"])))
        limit = round_step(bound(best, side), unit(int(meta["priceDecimals"])), side)
        venue_fee, builder = D(0), D(0)
    left, filled, cost = size, D(0), D(0)
    for px_s, sz_s in levels:
        if left <= 0:
            break
        px = D(px_s)
        if (side == "buy" and px > limit) or (side == "sell" and px < limit):
            break
        take = min(left, D(sz_s))
        if take <= 0:
            continue
        filled += take
        cost += take * px
        left -= take
    out = {"marketId": rec["marketId"], "side": side, "sizeBase": s(size), "limitPx": s(limit)}
    if left > 0:
        out["status"] = "insufficient_depth"
        return out
    avg = (cost / filled).quantize(D("1e-12"), rounding=ROUND_HALF_EVEN)
    worse = (avg - best) if side == "buy" else (best - avg)
    slip = bps4(worse * D(10000) / best)
    fund = bps4(RATE * HOLD * D(10000)) * (1 if side == "buy" else -1)
    total = bps4(D(str(bps4(venue_fee))) + D(str(bps4(builder))) + D(str(slip)) + D(str(fund)))
    out.update({"status": "ok", "avgFillPx": s(avg), "slippageBps": slip, "venueFeeBps": bps4(venue_fee), "builderFeeBps": bps4(builder), "fundingCostBps": fund, "totalCostBps": total})
    return out


def main():
    result = {"note": "generated by scripts/golden-expected.py from test/fixtures/books; do not edit by hand", "scenarios": {}}
    for name in SETS:
        with open(os.path.join(BOOKS, name + ".json")) as fh:
            books = json.load(fh)["books"]
        result["scenarios"][name] = [scenario(name, i, r) for i, r in enumerate(books)]
    with open(OUT, "w") as fh:
        json.dump(result, fh, indent=1)
        fh.write("\n")
    for name, xs in result["scenarios"].items():
        print(name, len(xs), "ok", sum(1 for x in xs if x["status"] == "ok"))


main()
