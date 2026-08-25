"""Automated readers: tape, book, and the combined interpretation.

Arash's ask (2026-08-25): algorithms that read the tape and the book as they
flow and extract a signal, plus a third combining both. These are deliberate,
interpretable microstructure heuristics — every score decomposes into named
parts the UI can show, and the combined verdict comes from an explicit rule
table, not a black box. Scores are −100 (selling/offer-heavy) .. +100
(buying/bid-heavy).

Honesty notes baked into the design: the tape is the FACTS layer, so the
combiner weights it higher; the book is the CLAIMS layer, so walls only count
fully when the heat ring shows them persisting (a wall that just appeared is
spoof-grade evidence). "Buying into a persistent offer wall" is flagged as
absorption risk, not bullishness — the classic tape-reading trap.
"""

from __future__ import annotations

import time


def _clamp(value: float, low: float = -100.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def tape_signal(pressure: list[tuple[float, str, float]],
                big_threshold: float,
                cvd_minutes: dict[int, float],
                now: float | None = None) -> dict:
    """Read the trade flow.

    Parts: flow  — all-trade aggressor imbalance over the 5-minute window;
           big   — same, big prints only (whales lean which way?);
           burst — last-minute notional vs the window's per-minute average
                   (is something happening RIGHT NOW?), sign follows flow;
           cvd   — slope of cumulative delta over the last 10 minutes.
    """
    now = now if now is not None else time.time()
    buy = sum(n for _, side, n in pressure if side == "buy")
    sell = sum(n for _, side, n in pressure if side == "sell")
    total = buy + sell
    flow = (buy - sell) / total if total else 0.0

    big_buy = sum(n for _, side, n in pressure if side == "buy" and n >= big_threshold)
    big_sell = sum(n for _, side, n in pressure if side == "sell" and n >= big_threshold)
    big_total = big_buy + big_sell
    big = (big_buy - big_sell) / big_total if big_total else 0.0

    last_minute = sum(n for ts, _, n in pressure if ts >= now - 60)
    per_minute_avg = total / 5 if total else 0.0
    burst_ratio = last_minute / per_minute_avg if per_minute_avg else 0.0
    burst = _clamp((burst_ratio - 1.0) / 2.0, 0.0, 1.0) * (1 if flow >= 0 else -1)

    recent = sorted(cvd_minutes)[-10:]
    cvd_delta = sum(cvd_minutes[m] for m in recent)
    cvd_scale = max(total, 1.0)
    cvd = _clamp(cvd_delta / cvd_scale, -1.0, 1.0)

    score = _clamp(100 * (0.45 * flow + 0.30 * big + 0.10 * burst + 0.15 * cvd))
    return {"score": round(score, 1),
            "parts": {"flow": round(flow, 3), "big": round(big, 3),
                      "burst": round(burst, 3), "cvd": round(cvd, 3)},
            "volume5m": round(total, 2)}


def _wall_persistence(price: float, ring: list, bin_size: float) -> float:
    """Share of recent heat-ring columns where this level held real size —
    0.0 = just appeared (spoof-grade), 1.0 = persistent."""
    recent = ring[-30:]  # ~5 minutes at 10s cadence
    if not recent:
        return 0.0
    hits = 0
    for _, bids, asks in recent:
        for levels in (bids, asks):
            if any(abs(level_price - price) <= bin_size for level_price, _ in levels):
                hits += 1
                break
    return hits / len(recent)


def book_signal(imbalance: float | None, walls: dict, mid: float | None,
                ring: list, bin_size: float) -> dict:
    """Read the resting book.

    Parts: imbalance — near-mid bid share, recentred to −1..+1;
           wallpull  — which side's biggest PERSISTENT wall sits closer
                       (liquidity magnets: price tends to travel toward
                       size, so a close big ask wall pulls up… but also
                       caps; sign convention: closer/persistent bid wall
                       below → support → positive).
    Wall influence is scaled by ring persistence — fresh walls count little.
    """
    imbalance_part = 0.0 if imbalance is None else (imbalance - 0.5) * 2

    wallpull = 0.0
    strongest = {"bids": None, "asks": None}
    if mid:
        for side in ("bids", "asks"):
            best_weight = 0.0
            for entry in walls.get(side, []):
                price, usd = entry[0], entry[1]
                distance = abs(price / mid - 1)
                if distance > 0.02 or distance == 0:
                    continue
                persistence = _wall_persistence(price, ring, bin_size)
                weight = usd * persistence / max(distance, 0.0005)
                if weight > best_weight:
                    best_weight = weight
                    strongest[side] = {"price": price, "usd": usd,
                                       "distPct": round(distance * 100, 2),
                                       "persistence": round(persistence, 2)}
            if side == "bids":
                bid_weight = best_weight
        ask_weight = best_weight
        total_weight = bid_weight + ask_weight
        if total_weight:
            wallpull = (bid_weight - ask_weight) / total_weight

    score = _clamp(100 * (0.65 * imbalance_part + 0.35 * wallpull))
    return {"score": round(score, 1),
            "parts": {"imbalance": round(imbalance_part, 3),
                      "wallpull": round(wallpull, 3)},
            "strongest": strongest}


def combined_signal(tape: dict, book: dict) -> dict:
    """The interpretation layer — explicit rules, facts outweigh claims."""
    t, b = tape["score"], book["score"]
    score = _clamp(0.65 * t + 0.35 * b)

    ask_wall = book["strongest"].get("asks")
    bid_wall = book["strongest"].get("bids")
    if t >= 30 and ask_wall and ask_wall["persistence"] >= 0.5 and ask_wall["distPct"] <= 0.5:
        verdict = (f"absorption risk: buying pressing into a persistent "
                   f"${ask_wall['usd']/1e6:.1f}M offer wall {ask_wall['distPct']}% above")
    elif t <= -30 and bid_wall and bid_wall["persistence"] >= 0.5 and bid_wall["distPct"] <= 0.5:
        verdict = (f"absorption risk: selling pressing into a persistent "
                   f"${bid_wall['usd']/1e6:.1f}M bid wall {bid_wall['distPct']}% below")
    elif t >= 30 and b >= 20:
        verdict = "aligned: buyers aggressive and the book leans bid — path of least resistance is up"
    elif t <= -30 and b <= -20:
        verdict = "aligned: sellers aggressive and the book leans offered — path of least resistance is down"
    elif abs(t) >= 30 and abs(b) < 20:
        verdict = ("one-sided tape into a neutral book — momentum without "
                   "structure, moves can extend or snap back fast")
    elif abs(t) < 15 and abs(b) >= 30:
        verdict = "book leaning without tape confirmation — claims only, wait for prints"
    else:
        verdict = "no clear read — flows and book are mixed"
    return {"score": round(score, 1), "verdict": verdict}
