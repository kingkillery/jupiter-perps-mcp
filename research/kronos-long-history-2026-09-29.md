# Kronos long-history experiment, declared before execution

Research only. This experiment does not change the live model, wallet controls, or trading rules.

- Source: Coinbase Exchange public `SOL-USD` spot OHLCV, 15-minute candles. Request the complete UTC interval 2026-08-16 00:00 through 2026-09-15 00:00, excluding the end. Reject gaps, duplicates, invalid OHLCV, and incomplete responses; do not fill missing candles.
- Model: locally pinned `NeoQuasar/Kronos-mini` and tokenizer revisions in `kronos/manifest.json`. Sampling stays at seed 42, temperature 1.0, top-p 0.9, and three paths averaged.
- Forecast target: all eight next 15-minute closing prices (two hours). Primary metric is mean absolute error in USD across every predicted point. The unchanged-origin-close forecast is the primary baseline on identical timestamps. Endpoint direction is descriptive only.
- Candidate settings: current 128 completed input candles and alternative 64 completed input candles. No other setting is searched. Prior short-archive results are development evidence and motivate this comparison; they are not pooled with it.
- Decision times: 24 equally spaced, non-overlapping eight-candle outcome windows across the 30-day dataset. The first 12 chronological windows are selection data; the last 12 are held-out scoring data. Select the lookback with lower selection MAE; ties retain 128. Score both frozen settings and the baseline on the later windows, but do not reselect from their scores.
- Trial accounting: 2 lookback settings, 24 windows each, 48 model forecasts, plus a deterministic unchanged-price baseline. Record the full candle-array SHA-256, exact times, source and model revisions, every prediction and label, selection decision, and all errors. Save under ignored `.runtime/kronos-long-history/`.
- Interpretation: A historical holdout is not a prospective confirmation. Pretrained-model overlap and prior human exposure cannot be excluded. Coinbase spot is not Jupiter Perps execution data, so no fill, fee, funding, liquidation, or PnL claim follows. No live adoption from this single run, even if it beats baseline.

Source API: https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles

## Result recorded after the declared run

The fetch produced 2,880 contiguous candles with SHA-256 `71d0428e1d39bda0c2b9dd5fe2e9da6ad17f7e488b3b116071e3833e83a94e16`. All 48 predeclared forecasts completed. The 64-candle setting won earlier-window selection MAE ($0.6045 versus $0.6127 for 128) and was frozen before holdout inference. On the 12 later windows, its MAE was $0.3465 versus $0.3786 for 128 and **$0.3257 for unchanged price**. It beat unchanged price on 5 of 12 individual windows. The selected setting therefore failed the primary baseline and will not replace the live 128-candle setting.

The full dataset, predictions, per-window labels, and local report are stored under ignored `.runtime/kronos-long-history/`. The independent archive validator and the Kronos end-to-end check passed. These past windows are now inspected development data; a future prospective check is required before any adoption claim.
