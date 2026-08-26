"""OKX liquidation parsing — the feed the layer runs on now that
Binance's forceOrder stream has gone silent (verified 2026-08-27: four
minutes on the all-market feed, socket open, zero frames)."""

from market_lens.venues import parse_okx_liquidations

INST_TO_KEY = {"ETH-USDT-SWAP": "ETH", "BTC-USDT-SWAP": "BTC",
               "XRP-USDT-SWAP": "XRP"}
MULTIPLIERS = {"ETH-USDT-SWAP": 0.1, "BTC-USDT-SWAP": 0.01,
               "XRP-USDT-SWAP": 100.0}


def frame(inst: str, details: list[dict]) -> dict:
    return {"arg": {"channel": "liquidation-orders", "instType": "SWAP"},
            "data": [{"instId": inst, "instFamily": inst.rsplit("-", 1)[0],
                      "instType": "SWAP", "details": details}]}


def detail(pos_side="long", size="4", price="2489.6", ts="1787784670311"):
    return {"bkLoss": "0", "bkPx": price, "ccy": "", "posSide": pos_side,
            "side": "sell" if pos_side == "long" else "buy", "sz": size, "ts": ts}


def test_contract_size_is_applied():
    """Four ETH swap contracts are 0.4 ETH, not 4 — the same trap that had
    okx-fut trades reading 100x too large."""
    [(key, liq)] = parse_okx_liquidations(
        frame("ETH-USDT-SWAP", [detail()]), INST_TO_KEY, MULTIPLIERS)
    assert key == "ETH"
    assert liq["size"] == 0.4
    assert liq["notional"] == 2489.6 * 0.4


def test_side_is_who_died():
    [(_, long_liq)] = parse_okx_liquidations(
        frame("ETH-USDT-SWAP", [detail(pos_side="long")]), INST_TO_KEY, MULTIPLIERS)
    [(_, short_liq)] = parse_okx_liquidations(
        frame("ETH-USDT-SWAP", [detail(pos_side="short")]), INST_TO_KEY, MULTIPLIERS)
    assert long_liq["side"] == "long"
    assert short_liq["side"] == "short"


def test_multiple_details_in_one_frame():
    rows = parse_okx_liquidations(
        frame("BTC-USDT-SWAP", [detail(size="100", price="78000"),
                                detail(size="50", price="78010")]),
        INST_TO_KEY, MULTIPLIERS)
    assert [liq["size"] for _, liq in rows] == [1.0, 0.5]


def test_unconfigured_instrument_is_ignored():
    assert parse_okx_liquidations(
        frame("DOGE-USDT-SWAP", [detail()]), INST_TO_KEY, MULTIPLIERS) == []


def test_missing_multiplier_does_not_silently_scale():
    """An instrument with no ctVal falls back to 1.0 rather than crashing,
    but the adapter refuses to start without the map at all."""
    rows = parse_okx_liquidations(frame("ETH-USDT-SWAP", [detail()]),
                                  INST_TO_KEY, {})
    assert rows[0][1]["size"] == 4.0


def test_malformed_details_are_skipped_not_fatal():
    rows = parse_okx_liquidations(
        frame("ETH-USDT-SWAP", [
            {"bkPx": "abc", "sz": "1", "posSide": "long", "ts": "1"},
            {"bkPx": "0", "sz": "1", "posSide": "long", "ts": "1"},
            {"bkPx": "100", "sz": "0", "posSide": "long", "ts": "1"},
            {"bkPx": "100", "sz": "1", "posSide": "sideways", "ts": "1"},
            detail(),
        ]), INST_TO_KEY, MULTIPLIERS)
    assert len(rows) == 1


def test_frames_without_data():
    assert parse_okx_liquidations({}, INST_TO_KEY, MULTIPLIERS) == []
    assert parse_okx_liquidations({"data": []}, INST_TO_KEY, MULTIPLIERS) == []
    assert parse_okx_liquidations(
        frame("ETH-USDT-SWAP", []), INST_TO_KEY, MULTIPLIERS) == []
