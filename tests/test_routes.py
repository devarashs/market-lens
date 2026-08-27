"""Server routes must not shadow client routes.

The app is a SPA behind a catch-all: anything the server does not claim
falls through to index.html so deep links work. That means every server
route silently WINS over a client route of the same path.

It bit on 2026-08-27: the watchlist's data was served at /markets, which
is also the page's own URL, so the header link worked (React routed
in-app) while typing the URL or reloading returned raw JSON. Nothing
errored — the page simply was not there.

These parse both route tables from source rather than importing the app,
so the check costs nothing and cannot be defeated by import side effects.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_PY = ROOT / "market_lens" / "server.py"
APP_TSX = ROOT / "app" / "src" / "App.tsx"

SERVER_ROUTE = re.compile(r'router\.add_get\(\s*"(?P<path>[^"]+)"')
CLIENT_ROUTE = re.compile(r'<Route\s+path="(?P<path>[^"]+)"')


def server_routes() -> set[str]:
    return {match["path"]
            for match in SERVER_ROUTE.finditer(SERVER_PY.read_text(encoding="utf-8"))}


def client_routes() -> set[str]:
    """Only the static ones. The dynamic `/:symbol?/:timeframe?` catch-all
    matches everything, so comparing it would flag every API route."""
    return {match["path"]
            for match in CLIENT_ROUTE.finditer(APP_TSX.read_text(encoding="utf-8"))
            if ":" not in match["path"] and "*" not in match["path"]}


def test_both_route_tables_were_actually_found():
    """A regex that matched nothing would make the real check vacuous."""
    assert len(server_routes()) >= 4
    assert len(client_routes()) >= 2


def test_no_server_route_shadows_a_page():
    overlap = server_routes() & client_routes()
    assert overlap == set(), (
        f"{sorted(overlap)} is served by BOTH the collector and the SPA. "
        "The server wins, so the page 404s into JSON on direct navigation. "
        "Put data routes under /api/.")


def test_the_watchlist_data_route_stayed_under_api():
    """The specific regression: /markets is the page, /api/markets the data."""
    routes = server_routes()
    assert "/api/markets" in routes
    assert "/markets" not in routes


def test_the_spa_catch_all_is_still_last_resort():
    """Deep links only work because an unclaimed path falls through to the
    app; if this route ever disappears, /markets and /docs break on reload."""
    assert "/{tail:.*}" in server_routes()


def test_health_is_under_api_too():
    """Same rule as the watchlist: a data route must not be able to shadow
    a page the SPA might add later."""
    assert "/api/health" in server_routes()
