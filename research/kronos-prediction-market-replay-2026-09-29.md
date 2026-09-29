# Exploratory Kronos / prediction-market SOL replay

Research only. No wallet call, trade, live model setting, or execution rule changed.

## Fixed replay

- Eight SOL sessions: September 7–14, 2026, at 12:00 UTC each day. Each has a next 15-minute and a next one-hour outcome. These dates are from the already inspected Coinbase archive, so they are **development evidence, not a clean holdout**.
- Model: pinned Kronos-mini and tokenizer, 64 completed candles, seed 42, temperature 1, top-p 0.9, three paths averaged, on one ephemeral Modal L4. One 15-minute and one one-hour candle forecast per date. The one-hour candles are exact aggregates of four contiguous archived 15-minute candles. The archive hash is `71d0428e1d39bda0c2b9dd5fe2e9da6ad17f7e488b3b116071e3833e83a94e16`.
- Range accuracy uses Coinbase SOL-USD spot high/low. Baseline copies the immediately preceding completed candle's high and low. A model high/low pair is a point forecast of the next candle's extremes, not a calibrated prediction interval.
- Contract outcomes use each platform's own settlement. Polymarket 15-minute SOL up/down uses Chainlink SOL/USD TWAP; its hourly contract uses Binance SOL/USDT hourly open and close. Kalshi 15-minute SOL up/down and the hourly SOL strike ladder use CF Benchmarks SOL/USD RTI averages. These are not Coinbase spot prices and the hourly Kalshi strike contract is not an up/down-from-open contract.
- Polymarket's sampled Up price is the latest point at or before each session start, 41–50 seconds old. Kalshi's bid/ask midpoint is from the first one-minute candle ending 60 seconds **after** the session starts. These snapshots are neither simultaneous nor executable matched quotes; their directional hit counts are descriptive only.
- For Kalshi hourly, the threshold contract nearest the known prior Coinbase close was selected without consulting eventual volume or result. The model's close forecast, separately from its high/low forecast, determines a hypothetical yes/no call at that strike.

Primary source descriptions: [Kronos predictor output](https://github.com/shiyu-coder/Kronos), [Polymarket data APIs](https://institute.polymarket.com/data), [Kalshi candlestick API](https://docs.kalshi.com/api-reference/market/get-market-candlesticks), [Kalshi crypto settlement sources](https://help.kalshi.com/en/articles/13823838-crypto-markets).

## Observed result

| Measure | 15 minutes | One hour |
|---|---:|---:|
| Fixed sessions | 8 | 8 |
| Kronos mean high/low MAE | $0.1126 | $0.5273 |
| Previous-candle high/low MAE | $0.1131 | $0.5150 |
| Both actual extremes inside forecast range | 3/8 | 1/8 |
| Model close direction vs Polymarket outcome | 5/8 | 5/8 |
| Model close call vs selected Kalshi outcome | 5/8 | 6/8 |
| Kalshi strikes outside forecast high/low range | 0/8 | 1/8, wrong |

The 15-minute range result is effectively a tie with the trivial range baseline; the hourly range is worse. High/low alone does not give a useful contract call here: all eight 15-minute Kalshi targets and seven of eight hourly strikes fall inside the predicted range. A range straddling the threshold does not imply a calibrated Up/Yes probability.

The pre-start Polymarket sampled price was directionally correct in 3 of 6 non-tied 15-minute sessions and 4 of 6 non-tied hourly sessions. The Kalshi first-minute midpoint was directionally correct in 5 of 8 15-minute and 3 of 7 non-tied hourly selected contracts. These counts are **not** evidence that Kronos beats either market: the timestamps, price sources, contract types, and odds representations differ, and eight observations per timeframe are far too few. None of the scores includes tradable bids/asks at model issuance, fees, or slippage.

The raw forecast, contract metadata and timestamped quotes, and independently recomputed scores are in ignored `.runtime/kronos-market-ranges/`. The [Modal run](https://modal.com/apps/pkkidking/main/ap-ZR2qfg5GZYcA6jAhWxR1NU) completed and shut down. Keep this result research-only. A meaningful market comparison would need prospective, venue-aligned forecasts and simultaneous executable quotes, with a model probability for the exact contract event rather than treating forecast high/low as a probability.
