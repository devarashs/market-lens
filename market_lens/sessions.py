"""Trading-hub sessions, and each one's live share of traded volume.

Ported from the arena dashboard (2026-08-28) at Arash's request, with the
one change that makes it worth porting: over there the volume shares are
frozen text from the August session study, so the card says "35% of BTC
volume" forever. Here they are recomputed from `flow_minutes`, which
records every minute of executed flow we have ever seen, so the number
describes the market rather than the day somebody measured it.

The study's own figures are kept beside the live ones. A session drifting
away from its historical share is the interesting event, and you can only
see it if both numbers are on screen.

Windows are UTC and deliberately contiguous — every hour belongs to exactly
one session, so the shares sum to 100% and nothing hides in a gap.

Pure module: no I/O, no clock. The caller supplies the hour and the volume.
"""

from __future__ import annotations

# key, display name, hubs, start hour (inclusive), end hour (exclusive),
# and the share measured in docs/research/sessions.md for comparison.
SESSIONS: tuple[dict, ...] = (
    {"key": "asia", "name": "Asia", "hubs": "Tokyo · Hong Kong · Singapore",
     "start": 0, "end": 8, "studyShare": 28.0},
    {"key": "europe", "name": "Europe", "hubs": "London · Frankfurt",
     "start": 8, "end": 14, "studyShare": 26.0},
    {"key": "us", "name": "United States", "hubs": "New York · equity open 13:30",
     "start": 14, "end": 21, "studyShare": 35.0},
    {"key": "late", "name": "Late / after-hours", "hubs": "post-US close",
     "start": 21, "end": 24, "studyShare": 10.0},
)

HOURS_IN_DAY = 24


def session_of(hour: int) -> str | None:
    """Which session a UTC hour belongs to. None for an impossible hour."""
    if not 0 <= hour < HOURS_IN_DAY:
        return None
    for session in SESSIONS:
        if session["start"] <= hour < session["end"]:
            return session["key"]
    return None


def coverage_is_total() -> bool:
    """Every hour belongs to exactly one session. Held as a function so the
    test can assert the invariant rather than trusting the table."""
    return all(session_of(hour) is not None for hour in range(HOURS_IN_DAY))


def shares(volume_by_hour: dict[int, float]) -> list[dict]:
    """Per-session volume and share of the total.

    `volume_by_hour` maps UTC hour-of-day to traded notional. Returns one
    row per session in clock order. Share is None when nothing traded —
    zero would claim a measured emptiness rather than an absent measurement.
    """
    total = sum(max(0.0, v) for v in volume_by_hour.values())
    rows = []
    for session in SESSIONS:
        volume = sum(max(0.0, volume_by_hour.get(hour, 0.0))
                     for hour in range(session["start"], session["end"]))
        rows.append({
            **session,
            "volume": round(volume, 2),
            "sharePct": round(volume / total * 100, 2) if total > 0 else None,
            # Positive = busier than the August study found it.
            "driftPct": (round(volume / total * 100 - session["studyShare"], 2)
                         if total > 0 else None),
        })
    return rows


def hourly_profile(volume_by_hour: dict[int, float]) -> list[dict]:
    """All 24 hours, each with its share — the histogram behind the cards.

    Every hour is present even when it traded nothing, so the chart keeps a
    stable x-axis instead of collapsing around quiet hours.
    """
    total = sum(max(0.0, v) for v in volume_by_hour.values())
    return [{
        "hour": hour,
        "volume": round(max(0.0, volume_by_hour.get(hour, 0.0)), 2),
        "sharePct": (round(max(0.0, volume_by_hour.get(hour, 0.0)) / total * 100, 3)
                     if total > 0 else None),
        "session": session_of(hour),
    } for hour in range(HOURS_IN_DAY)]
