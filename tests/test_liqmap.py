"""LiquidationEstimator: projection, attribution, consumption, decay."""

from market_lens.liqmap import (
    MAX_ATTRIBUTION_GAP_MS,
    LEVERAGE_TIERS,
    LiquidationEstimator,
)


def make(price_bin: float = 10.0) -> LiquidationEstimator:
    return LiquidationEstimator(price_bin)


HOUR_MS = 3_600_000


def test_first_observation_only_sets_baseline():
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    assert est.bands() == []


def test_oi_increase_projects_tier_bands_both_sides():
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 1_010_000_000.0, 0.0)  # +10M, neutral flow
    bands = est.bands()
    prices = [row[0] for row in bands]
    # 10x tier: longs die at 72,000, shorts at 88,000.
    assert 72_000.0 in prices and 88_000.0 in prices
    row_10x = next(row for row in bands if row[0] == 72_000.0)
    # Neutral flow -> 50/50 split; 10x tier weight 0.35 -> 10M * 0.35 * 0.5.
    assert row_10x[1] == round(10_000_000 * 0.35 * 0.5, 0)
    assert len(bands) == 2 * len(LEVERAGE_TIERS)


def test_flow_attribution_leans_the_split():
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 1_010_000_000.0, 5_000_000.0)  # buy-heavy
    bands = est.bands()
    long_total = sum(row[1] for row in bands)
    short_total = sum(row[2] for row in bands)
    assert long_total > short_total  # buying ⇒ new inventory leans long


def test_price_crossing_consumes_bands():
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 1_010_000_000.0, 0.0)
    # Price crashes to 71,000: every long band at/above it is spent
    # (72,000, 76,000... fired), and short bands below 71,000 (none) stay.
    est.observe(120_000, 71_000.0, 1_010_000_000.0, 0.0)
    remaining_long_levels = [row[0] for row in est.bands() if row[1] > 0]
    assert all(level < 71_000.0 for level in remaining_long_levels)
    # Short bands above price survive untouched.
    assert any(row[2] > 0 and row[0] > 71_000.0 for row in est.bands())


def test_decay_halves_at_half_life():
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 1_100_000_000.0, 0.0)  # +100M
    before = sum(row[1] + row[2] for row in est.bands())
    est.observe(60_000 + 24 * HOUR_MS, 80_000.0, 1_100_000_000.0, 0.0)
    after = sum(row[1] + row[2] for row in est.bands())
    assert after < before * 0.55  # halved by decay (consumption trims a touch more)


def test_oi_decrease_adds_nothing():
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 990_000_000.0, 0.0)
    assert est.bands() == []


def test_dust_is_dropped():
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 1_000_100_000.0, 0.0)  # +100k: all tiers dust
    assert est.bands() == []


# ------------------------------------------------------- restart / replay


OBSERVATIONS = [
    (0,       80_000.0, 1_000_000_000.0, 0.0),
    (60_000,  80_100.0, 1_050_000_000.0, 4_000_000.0),
    (120_000, 79_800.0, 1_070_000_000.0, -2_000_000.0),
    (180_000, 79_950.0, 1_065_000_000.0, 500_000.0),
    (240_000, 80_400.0, 1_120_000_000.0, 9_000_000.0),
]


def test_replaying_observations_reproduces_the_map():
    """The restart guarantee: the estimator is a pure function of its
    observation sequence, so a rebuilt instance must match the live one."""
    live = make()
    for observation in OBSERVATIONS:
        live.observe(*observation)
    rebuilt = make()
    for observation in OBSERVATIONS:  # what seed_liq_estimators replays
        rebuilt.observe(*observation)
    assert rebuilt.bands() == live.bands()
    assert rebuilt.bands() != []  # a vacuous match would prove nothing


def test_replay_then_live_observation_continues_seamlessly():
    uninterrupted = make()
    for observation in OBSERVATIONS:
        uninterrupted.observe(*observation)
    uninterrupted.observe(300_000, 80_500.0, 1_150_000_000.0, 3_000_000.0)

    restarted = make()
    for observation in OBSERVATIONS:
        restarted.observe(*observation)
    restarted.observe(300_000, 80_500.0, 1_150_000_000.0, 3_000_000.0)

    assert restarted.bands() == uninterrupted.bands()


def test_long_gap_decays_and_consumes_but_does_not_attribute():
    """After downtime the OI change cannot be placed at any one price —
    but elapsed decay and the bands price traded through still apply."""
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 1_100_000_000.0, 0.0)
    before = sum(row[1] + row[2] for row in est.bands())

    gap_ms = MAX_ATTRIBUTION_GAP_MS + 60_000
    est.observe(60_000 + gap_ms, 80_000.0, 5_000_000_000.0, 0.0)  # +3.9B over the gap
    after = sum(row[1] + row[2] for row in est.bands())
    assert after < before  # decayed, and nothing projected from the huge jump


def test_bands_below_the_floor_are_forgotten():
    """Decayed-to-nothing bins are deleted, not kept forever: unbounded
    growth would slow every later decay pass and the startup replay."""
    est = make()
    est.observe(0, 80_000.0, 1_000_000_000.0, 0.0)
    est.observe(60_000, 80_000.0, 1_000_006_000.0, 0.0)  # tiny bands, above floor
    assert est._bands  # they exist internally even though bands() hides them
    est.observe(60_000 + 40 * HOUR_MS, 80_000.0, 1_000_006_000.0, 0.0)
    assert est._bands == {}
