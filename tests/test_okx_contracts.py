"""OKX swap sizes are contracts, not coins.

One BTC-USDT-SWAP contract is 0.01 BTC and one DOGE-USDT-SWAP is 1000
DOGE, so a raw `sz` overstates BTC by 100x and understates DOGE by
1000x. That reached the tape as phantom whales and the depth aggregate
as a fake wall before it was caught (2026-08-26).
"""

import pytest

from market_lens.venues import _scale_levels, parse_contract_values

PAYLOAD = {"data": [
    {"instId": "BTC-USDT-SWAP", "ctVal": "0.01", "ctMult": "1"},
    {"instId": "ETH-USDT-SWAP", "ctVal": "0.1", "ctMult": "1"},
    {"instId": "SOL-USDT-SWAP", "ctVal": "1", "ctMult": "1"},
    {"instId": "DOGE-USDT-SWAP", "ctVal": "1000", "ctMult": "1"},
    {"instId": "XRP-USDT-SWAP", "ctVal": "100", "ctMult": "1"},
]}


def test_spot_levels_pass_through_untouched():
    rows = [["79000.5", "1.25", "0", "3"], ["79000.0", "0.5", "0", "1"]]
    assert _scale_levels(rows, 1.0) == [["79000.5", "1.25"], ["79000.0", "0.5"]]


def test_swap_levels_convert_contracts_to_coins():
    rows = [["79000.5", "100", "0", "3"]]      # 100 contracts
    assert _scale_levels(rows, 0.01) == [["79000.5", 1.0]]  # = 1 BTC


def test_doge_contracts_scale_up_not_down():
    assert _scale_levels([["0.09", "2"]], 1000.0) == [["0.09", 2000.0]]


def test_scaling_keeps_the_price_untouched():
    [[price, _size]] = _scale_levels([["79000.5", "100"]], 0.01)
    assert price == "79000.5"


def test_empty_levels():
    assert _scale_levels([], 0.01) == []


def test_parses_only_the_instruments_asked_for():
    values = parse_contract_values(PAYLOAD, ["BTC-USDT-SWAP", "DOGE-USDT-SWAP"])
    assert values == {"BTC-USDT-SWAP": 0.01, "DOGE-USDT-SWAP": 1000.0}


def test_ct_mult_multiplies_the_contract_value():
    payload = {"data": [{"instId": "X-USDT-SWAP", "ctVal": "0.5", "ctMult": "4"}]}
    assert parse_contract_values(payload, ["X-USDT-SWAP"]) == {"X-USDT-SWAP": 2.0}


def test_missing_contract_value_raises_rather_than_defaulting():
    """Silently defaulting to 1.0 IS the bug. Raising makes the adapter
    retry instead of publishing sizes that are wrong by 100x."""
    with pytest.raises(RuntimeError, match="ctVal missing"):
        parse_contract_values(PAYLOAD, ["BTC-USDT-SWAP", "NOPE-USDT-SWAP"])


def test_empty_response_raises_for_everything():
    with pytest.raises(RuntimeError):
        parse_contract_values({}, ["BTC-USDT-SWAP"])


def test_the_real_multipliers_match_what_broke():
    """The regression itself, in numbers: BTC 100x over, ETH 10x over,
    SOL untouched (which is why it looked fine), DOGE 1000x under."""
    values = parse_contract_values(
        PAYLOAD, ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP",
                  "DOGE-USDT-SWAP"])
    assert values["BTC-USDT-SWAP"] == 0.01
    assert values["ETH-USDT-SWAP"] == 0.1
    assert values["SOL-USDT-SWAP"] == 1.0
    assert values["DOGE-USDT-SWAP"] == 1000.0


# ------------------------------------------------------- deribit unit safety

from market_lens.venues import deribit_levels


def test_deribit_levels_convert_usd_notional_to_base_size():
    """Deribit's inverse perps quote `amount` in USD, every other venue
    here quotes base units. Mixing the two silently corrupts the aggregate
    book — the same shape as the OKX contract bug."""
    rows = [["new", 80_000.0, 8_000.0], ["change", 79_000.0, 790.0]]
    assert deribit_levels(rows) == [[80_000.0, 0.1], [79_000.0, 0.01]]


def test_deribit_delete_rows_become_zero_size():
    """A delete carries amount 0, which DeltaBook already treats as a
    removal — so the action field needs no special case."""
    assert deribit_levels([["delete", 80_000.0, 0.0]]) == [[80_000.0, 0.0]]


def test_deribit_levels_survive_a_zero_price():
    """Never divide by zero on a malformed row; a zero-size level is
    dropped by DeltaBook, which is the right outcome."""
    assert deribit_levels([["new", 0.0, 500.0]]) == [[0.0, 0.0]]


def test_deribit_levels_handle_an_empty_side():
    assert deribit_levels([]) == []
