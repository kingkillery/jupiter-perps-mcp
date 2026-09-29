# Modal Kronos tuning sweep, declared before execution

Research only. The connected wallet and the live 128-candle CPU forecast stay unchanged. Run the pinned local Kronos-mini model and tokenizer on a single Modal L4 GPU; transfer only public Coinbase candle data and the pinned public model files. No environment keys, wallet files, or live server state enter the Modal image or function.

Use the already archived 2,880 Coinbase SOL-USD 15-minute candles from 2026-08-16 through 2026-09-15, source SHA-256 `71d0428e1d39bda0c2b9dd5fe2e9da6ad17f7e488b3b116071e3833e83a94e16`. Score only the 12 earlier, non-overlapping eight-candle **development** windows from the prior long-history run. Do not score the already-inspected later windows in this sweep. All four candidates use 64 completed context candles, eight-step forecasts, seed 42, and the same model revision.

| Candidate | Temperature | Top-p | Sample paths |
|---|---:|---:|---:|
| current sampling | 1.0 | 0.9 | 3 |
| lower temperature | 0.7 | 0.9 | 3 |
| wider nucleus | 1.0 | 1.0 | 3 |
| more paths | 1.0 | 0.9 | 5 |

For each candidate, record raw eight-point MAE and MAE after the fixed half-strength transformation `origin + 0.5*(forecast-origin)`. Compare both with unchanged-origin-price MAE on precisely the same points. Preserve every predicted point, outcome, model revision, source hash, and trial count. If any candidate looks favorable, it remains a candidate for the previously specified **prospective 96-window** test; do not promote it or reselect from the old holdout. Do not train weights from this short dataset. Keep the Modal job ephemeral and bounded to one GPU and 15 minutes.

Modal documentation: https://modal.com/docs/guide/gpu
