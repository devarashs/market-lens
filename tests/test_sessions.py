"""Trading-hub sessions and their live volume shares."""

import pytest

from market_lens.sessions import (
    HOURS_IN_DAY, SESSIONS, coverage_is_total, hourly_profile, session_of, shares,
)


def flat(volume: float = 100.0) -> dict[int, float]:
    return {hour: volume for hour in range(HOURS_IN_DAY)}


class TestSessionOf:
    def test_maps_each_hour_to_its_hub(self):
        assert session_of(0) == "asia"
        assert session_of(7) == "asia"
        assert session_of(8) == "europe"
        assert session_of(13) == "europe"
        assert session_of(14) == "us"
        assert session_of(20) == "us"
        assert session_of(21) == "late"
        assert session_of(23) == "late"

    def test_every_hour_belongs_to_exactly_one_session(self):
        """Contiguous windows are what make the shares sum to 100% — a gap
        would silently swallow volume."""
        assert coverage_is_total()
        for hour in range(HOURS_IN_DAY):
            matches = [s for s in SESSIONS if s["start"] <= hour < s["end"]]
            assert len(matches) == 1, f"hour {hour} matched {len(matches)} sessions"

    def test_rejects_impossible_hours(self):
        assert session_of(-1) is None
        assert session_of(24) is None
        assert session_of(99) is None


class TestShares:
    def test_flat_volume_splits_by_window_length(self):
        rows = {r["key"]: r for r in shares(flat())}
        # 8, 6, 7 and 3 hours of the 24.
        assert rows["asia"]["sharePct"] == pytest.approx(8 / 24 * 100, abs=0.01)
        assert rows["europe"]["sharePct"] == pytest.approx(6 / 24 * 100, abs=0.01)
        assert rows["us"]["sharePct"] == pytest.approx(7 / 24 * 100, abs=0.01)
        assert rows["late"]["sharePct"] == pytest.approx(3 / 24 * 100, abs=0.01)

    def test_shares_sum_to_one_hundred(self):
        for volume in (flat(), {h: h * 1000.0 for h in range(HOURS_IN_DAY)}):
            assert sum(r["sharePct"] for r in shares(volume)) == pytest.approx(100, abs=0.05)

    def test_concentrated_volume_lands_in_the_right_session(self):
        rows = {r["key"]: r for r in shares({15: 5_000.0})}
        assert rows["us"]["sharePct"] == 100
        assert rows["asia"]["sharePct"] == 0
        assert rows["us"]["volume"] == 5_000

    def test_drift_is_measured_against_the_study(self):
        """The point of keeping the August figures: a session running hotter
        than it used to is the readable event."""
        rows = {r["key"]: r for r in shares({15: 1.0})}
        assert rows["us"]["driftPct"] == pytest.approx(100 - 35.0, abs=0.01)
        assert rows["asia"]["driftPct"] == pytest.approx(-28.0, abs=0.01)

    def test_no_volume_is_unknown_rather_than_zero_percent(self):
        rows = shares({})
        assert all(r["sharePct"] is None for r in rows)
        assert all(r["driftPct"] is None for r in rows)
        assert all(r["volume"] == 0 for r in rows)

    def test_negative_volume_cannot_poison_the_total(self):
        """flow_minutes should never produce one, but a share above 100%
        from a bad row would be worse than ignoring it."""
        rows = {r["key"]: r for r in shares({1: -5_000.0, 15: 100.0})}
        assert rows["us"]["sharePct"] == 100
        assert rows["asia"]["volume"] == 0

    def test_missing_hours_are_treated_as_quiet_not_absent(self):
        rows = {r["key"]: r for r in shares({0: 10.0, 15: 10.0})}
        assert rows["asia"]["sharePct"] == 50
        assert rows["europe"]["sharePct"] == 0


class TestHourlyProfile:
    def test_returns_a_stable_axis_of_all_hours(self):
        profile = hourly_profile({3: 100.0})
        assert [row["hour"] for row in profile] == list(range(24))
        assert profile[3]["sharePct"] == 100
        assert profile[4]["sharePct"] == 0

    def test_tags_each_hour_with_its_session(self):
        profile = hourly_profile(flat())
        assert profile[0]["session"] == "asia"
        assert profile[14]["session"] == "us"
        assert profile[23]["session"] == "late"

    def test_empty_input_gives_unknown_shares_not_zeros(self):
        profile = hourly_profile({})
        assert len(profile) == 24
        assert all(row["sharePct"] is None for row in profile)
