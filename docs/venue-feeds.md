# Venue feed reference — free public order-book + trade APIs

Research compiled 2026-08-25 (separate research session, saved here as the
adapter-roadmap reference). Everything below is keyless/free; rate limits and
geo-blocking are the things that drift — recheck docs before building.

**Integrated in Market Lens:** Binance (REST full depth + aggTrade WS),
Hyperliquid (l2Book + trades WS), Bybit (orderbook.200 + publicTrade WS),
OKX (books 400 + trades WS).

## Centralized exchanges

Binance leads all volume measures (~39% of top-10 spot volume); Bybit, OKX,
Coinbase, MEXC, Kraken, KuCoin round out the tier.

- **Binance** (spot + fapi futures): REST `/depth` up to 5000 levels; WS
  `<sym>@depth@100ms` diff stream, `@trade`/`@aggTrade`; ~6000 weight/min/IP,
  1024 streams/conn; free bulk history at data.binance.vision. Blocks US IPs.
- **Bybit** (v5 unified): WS `orderbook.{1|50|200|500|1000}.{sym}`,
  `publicTrade.{sym}`; REST `/v5/market/orderbook`; free historical dumps at
  public.bybit.com. Blocks US IPs.
- **OKX** (v5): WS `books` (400 levels, snapshot + 100ms diffs), `books5`,
  `bbo-tbt`, `trades`. Tick-by-tick deep books (`books-l2-tbt`) are
  VIP-gated; the free feed is very good.
- **Coinbase Advanced Trade**: WS `level2` + `market_trades` public, no JWT;
  Exchange feed exposes `full` (order-by-order L3). Best US-regulated
  liquidity. *(next adapter candidate — USD quotes)*
- **Kraken** (WS v2): `book` (depth 10–1000) + `trade`; L3 requires auth.
- **Bitget / KuCoin / Gate / HTX / MEXC**: free public depth + trades (KuCoin
  needs one keyless `POST /bullet-public` for a WS token; MEXC WS is
  protobuf). Weigh liquidity by depth, not reported turnover.
- **Deribit**: options + BTC/ETH perps; WS `book.{instr}.raw` tick-level L2.
- **Bitfinex** (`R0` raw L3) and **BitMEX** (`orderBookL2` with per-level
  IDs): low volume, unusually rich free data.

## Order-book DEXs (perps)

Top by 30d volume: Hyperliquid ($198B), Aster ($40B), Lighter ($34B), then
Grvt, ApeX. On-chain CLOBs → inherently public data.

- **Hyperliquid**: REST `POST /info l2Book` (~20 levels/side, sig-fig
  aggregation), WS `l2Book`/`trades`/`bbo`; ~1200 weight/min REST. Has spot.
- **Lighter** (zk-rollup): REST `order_books`, WS book batches every 50ms;
  official Python SDK; markets are numeric IDs.
- **Aster**: deliberately Binance-compatible API (swap the base URL); volume
  partly incentive-driven.
- **dYdX v4**: public indexer `indexer.dydx.trade/v4` — REST
  `/orderbooks/perpetualMarket/{ticker}`, WS `v4_orderbook`/`v4_trades`.
- **Paradex / edgeX / Grvt / Drift** (Solana DLOB `/l2` `/l3`) / Pacifica:
  public REST+WS, a tier below.

AMMs (Uniswap/Pancake/Raydium/Jupiter) have no order book — trades come from
swap events via RPC/subgraph; different integration class entirely.

## Shortcuts

- **CCXT** normalizes fetch/watchOrderBook + watchTrades across nearly all
  CEXs above plus Hyperliquid.
- **Tardis.dev** archives full-depth history for most venues (paid; free
  first-of-month samples) — relevant to L2 if our own archive has gaps.
