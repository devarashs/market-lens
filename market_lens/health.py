"""Process and liveness metrics for /api/health.

Written because the audit could not answer a basic question: is the
collector's event loop keeping up? There was no signal at all — the only
way to tell it was degraded was to open the UI and squint. That is not a
thing you can operate, and it makes every performance change unmeasurable,
which is worse.

Deliberately stdlib-only. A metrics dependency would be the tail wagging
the dog for six numbers, and `resource` plus `/proc` gives all of them on
the Linux box that actually runs this.

Two numbers carry most of the value:

  cpuPercent          CPU seconds burned per wall second, averaged since
                      start. Above ~80 on a 1-vCPU box means the loop is
                      saturated and ingestion is being starved.
  lastTradeAgeSeconds How long since ANY venue delivered a trade. Rises
                      only when the feeds are broken or the loop is
                      wedged, so it is the honest liveness check — a
                      process can be up and still be recording nothing.

Pure functions; the caller supplies the clock and the counters.
"""

from __future__ import annotations

import os
import time

try:                                    # Unix only; absent on Windows dev boxes.
    import resource
except ImportError:                     # pragma: no cover - not the deploy target
    resource = None


def cpu_seconds() -> float:
    """CPU consumed by this process, user + system.

    Falls back to `time.process_time` where `resource` is missing, which
    measures the same thing for a single-process server.
    """
    if resource is None:
        return time.process_time()
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return usage.ru_utime + usage.ru_stime


def rss_mb() -> float | None:
    """Resident memory in MB, or None where it cannot be read.

    `/proc/self/status` is authoritative and current on Linux;
    `ru_maxrss` is a high-water mark and its unit differs by platform, so
    it is only a fallback. None rather than a guess when neither works —
    a wrong memory number is worse than an absent one.
    """
    try:
        with open("/proc/self/status", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    if resource is None:
        return None
    try:
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Linux reports KB, macOS bytes. Anything above a gigabyte in the
        # raw number is bytes by elimination.
        return round(peak / (1024 * 1024) if peak > 1_000_000 else peak / 1024, 1)
    except (OSError, ValueError):
        return None


def cpu_percent(cpu_used: float, uptime: float) -> float | None:
    """CPU seconds per wall second, as a percentage. None before the
    process has run long enough for the ratio to mean anything."""
    if uptime < 1:
        return None
    return round(cpu_used / uptime * 100, 1)


def snapshot(started_at: float, now: float, *, clients: int, books: int,
             last_trade_at: float | None, symbols: int) -> dict:
    """One health reading. `last_trade_at` is a monotonic-comparable
    timestamp of the most recent trade from any venue, or None if none has
    arrived since boot."""
    uptime = max(0.0, now - started_at)
    used = cpu_seconds()
    age = None if last_trade_at is None else round(max(0.0, now - last_trade_at), 1)
    # Up but recording nothing is the failure this is here to catch, so it
    # is a degraded status rather than a healthy one.
    ok = age is not None and age < 120
    return {
        "status": "ok" if ok else "degraded",
        "uptimeSeconds": round(uptime, 1),
        "cpuSeconds": round(used, 1),
        "cpuPercent": cpu_percent(used, uptime),
        "rssMb": rss_mb(),
        "pid": os.getpid(),
        "clients": clients,
        "booksTracked": books,
        "symbols": symbols,
        "lastTradeAgeSeconds": age,
    }
