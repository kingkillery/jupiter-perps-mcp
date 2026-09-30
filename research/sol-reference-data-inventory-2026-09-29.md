# SOL prediction-market reference data inventory

Research archive only. No wallet action or live trade is implied. The newer sessions below are reserved for a future validation run; this inventory contains no model predictions, settlement outcomes, or scores for them.

## Fixed sessions and local archives

The existing replay covers eight daily 12:00 UTC origins from September 7–14, 2026. The untouched extension covers fourteen daily 12:00 UTC origins from September 15–28, each with one 15-minute and one hourly SOL market. Market metadata and timestamped quotes are in the ignored `.runtime/kronos-market-ranges/markets.json` and `.runtime/sol-reference-data/markets-new.json`. The former has 16 Polymarket quote samples and 16 Kalshi first-minute bid/ask samples; the latter has 28 of each. The new-period file has `sealed_for_future_scoring: true`.

The ignored `.runtime/sol-reference-data/` archive contains these validated, contiguous public spot candles (the end is exclusive):

| Source and interval | UTC range | Bars | SHA-256 of normalized bars |
| --- | --- | ---: | --- |
| Binance SOL/USDT, 1h | Sep 7–12 | 120 | `68379ea0d17fc87997e7883be73ed0140beb05d92f87af3be2fc743a0861ff8b` |
| Binance SOL/USDT, 1m | Sep 7–12 | 7,200 | `ef8a65da4d803b18059d83c16f0948f54e66c650b22ab4088ba54fa826a97e88` |
| Coinbase SOL-USD, 1m | Sep 7–12 | 7,200 | `8dfaa9a89b20f2cc04abd7095ed0f9ee77b7d9b8af9aff739185035ffe6360de` |
| Binance SOL/USDT, 1m | Sep 12–29 | 24,480 | `5341735118eef5a89c2ae74707be13163cda41047c1022ed008deb96cfc30090` |
| Coinbase SOL-USD, 1m | Sep 12–29 | 24,480 | `69e6525c0c8fd8b4e23e9970057dddbace4b209cbd8f17cb273fab63b662e941` |

The collector `node research/gather_sol_reference_prices.mjs` validates timestamp continuity, uniqueness, bar geometry, and nonnegative volume before caching. `node research/fetch_prediction_markets.mjs --new-period` collects the fixed later market sessions without looking at their outcomes. Source URLs and retrieval timestamps are embedded in the archive. The archive is intentionally ignored by Git because of its size; the manifest and hashes make it auditable locally.

## Settlement and quote boundaries

The 15-minute Polymarket markets specify the Chainlink **SOL/USD 60-second TWAP Data Stream**, while their hourly markets specify the **Binance SOL/USDT hourly candle**. These are different instruments and settlement rules. The public Chainlink SOL/USD CEX-price stream discovered through its catalog is **not** the named TWAP stream and must not be substituted. Kalshi crypto contracts use CF Benchmarks' SOL/USD RTI and a 60-second settlement average; its exact index values require Kalshi's authenticated CF Benchmarks history passthrough and account entitlement. The market `settlement_value_dollars` field is the contract payout, not the SOL reference price.

References: [Polymarket 15-minute market rules](https://polymarket.com/event/sol-updown-15m-1789660800), [Kalshi crypto settlement methodology](https://help.kalshi.com/en/articles/13823838-crypto-markets), [Kalshi CF Benchmarks history passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough), and [Chainlink Data Streams REST and discovery](https://docs.chain.link/data-streams/reference/data-streams-api/interface-api).

Polymarket's archived price is a sampled pre-start value, not an executable order-book fill. Kalshi's sampled bid/ask is from the first minute after start, so it sees some of the outcome window. These quotes are not time-matched, and neither quote sample alone establishes realizable profitability. Minute candles and the hourly Binance candle support context and cross-checks, but cannot establish an exact Chainlink or CF Benchmarks settlement tick.

## Validation use

Keep the September 15–28 sessions untouched until all candidate rules, quote timing, reference-feed mapping, and scoring code are frozen. Then score once with real settlement values where available, report missing-feed coverage separately, and preserve the raw source payloads and retrieval metadata. Do not impute exact settlement values from Coinbase or Binance spot prices.

`node research/probe_sol_settlement_feeds.mjs` is the bounded, read-only first step for credential-gated collection. With locally configured credentials it requests one historical `SOLUSD_RTI` response and the authenticated Chainlink SOL/USD catalog, stores the raw/metadata response only in the ignored runtime directory, and records access status without printing credentials. It does not assume that a generic SOL/USD CEX-price feed is the TWAP feed.
