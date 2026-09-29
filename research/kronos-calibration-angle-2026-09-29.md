# Kronos tuning angle: shrink forecast movement

This is a hypothesis generated **after** the 30-day historical holdout was inspected. It is exploratory evidence, not an additional clean test or a reason to change live forecasts.

The local Kronos-mini model forecasts eight closing prices from completed SOL candles. The prior [long-history experiment](./kronos-long-history-2026-09-29.md) selected a 64-candle lookback, yet its holdout error was $0.3465 versus $0.3257 for an unchanged-price forecast. The most direct tuning angle is **amplitude calibration**: retain the model's predicted direction and shape but reduce each predicted move away from the last completed close.

For a forecast price `P`, origin close `P0`, and fixed factor `a`, use `P_adjusted = P0 + a * (P - P0)`. Here `a=1` is raw Kronos and `a=0` is unchanged price. The read-only [diagnostic script](../scripts/analyze-kronos-calibration.mjs) examined five factors on the already-inspected 64-candle forecasts:

| Factor | Earlier selection MAE | Later historical MAE |
|---:|---:|---:|
| 0, unchanged price | $0.5989 | **$0.3257** |
| 0.25 | $0.5860 | $0.3227 |
| **0.50**, lowest selection error | **$0.5853** | $0.3260 |
| 0.75 | $0.5934 | $0.3349 |
| 1, raw Kronos | $0.6045 | $0.3465 |

Halving the move reduced MAE versus raw Kronos in both phases, and on the later windows it was nearly tied with unchanged price. It **did not beat** unchanged price there ($0.3260 versus $0.3257), and it beat that baseline on only 6 of 12 windows. The 0.25 factor happened to score $0.3227 on the later windows, but choosing it from that result would reuse an inspected holdout. This is a lead for future calibration work, not an estimated gain.

## Frozen next experiment

Collect a new, prospective SOL-USD 15-minute candle series after this note is committed. Before any outcomes are visible, save every complete 64-candle input, the raw eight-step forecast, model/source revision, and the fixed factor **0.50**. Score at least 96 non-overlapping two-hour decision windows over multiple weeks. Compare the raw forecast, the 0.50-adjusted forecast, and unchanged price on identical timestamps using eight-point MAE; report paired per-window error differences and uncertainty. Endpoint direction is secondary. Do not refit the factor, add filters, or switch lookback using those windows. Keep all variants research-only and require a new, separate confirmation period before changing live settings.

This test concerns spot forecast error only. It cannot establish profitable Jupiter Perps execution because fills, spread, fees, funding, slippage, and liquidation are not modeled.
