# Local Jupiter wallet setup

The server runs on `http://127.0.0.1:3002/mcp`. Open `http://127.0.0.1:3002/wallet` in the Comet profile containing Jupiter Wallet and connect one Solana account. Keep the page open. The server does not need or receive the private key in browser-wallet mode.

Client configuration is saved one directory above this repository in `.mcp.json`. Start manually with `npm run start:remote` from this repository. The current background process ID is recorded in `.runtime/server.pid`; logs are under `.runtime/`.

## Saved plan

`strategy.json` contains the SOL plan from “Intraday Chart Analysis”: $5 maximum planned loss including costs, lowest available leverage (1.1x in this integration) capped at 7x, completed 15-minute confirmation and retest, and equal thirds at the three targets.

| Setup | Reference entry | Stop | Equal-third targets |
|---|---:|---:|---|
| Long after breakout and retest | 119.20 | 118.60 | 119.90 / 120.60 / 121.00 |
| Short after rejection, breakdown and failed rebound | 118.70 | 119.30 | 117.90 / 117.10 / 116.40 |

This is a saved, unarmed plan. No price monitoring or automated entry runs. The $5 figure is planned risk, not a guaranteed realized-loss cap. Position size must account for actual fills, fees and execution allowance. The configured 200 bps slippage is wider than the approximate 50 bps reference stop distance; it must not be treated as compatible with the entry budget without recalculation.

## Entry controls

The wallet page now has a collateral amount, leverage (default 1.1x, maximum 7x), per-preview slippage, a borrowing-time allowance, a risk breakdown, and an entry review lock. The configured 200 bps default is preserved; previews reject slippage wider than the stop distance. No automatic leverage increase or automatic entry runs.

Risk includes the adverse entry fill and an adverse stop-execution allowance, quoted entry fees, a conservative exit fee allowance, borrowing for the selected hours, conversion costs, and a 0.03 SOL account/transaction reserve. The reserve is an explicit planning assumption, not a live fee quote. The holding allowance does not enforce a timed exit. Stop execution can exceed the allowance.

Live mainnet balances are read from RPC. Completed 15-minute SOL/USD candles come from Kraken spot, with the unfinished row discarded and a 25 bps comparison against Jupiter Perps price. The server rejects an existing SOL position, stale or invalid completed candles, a missing confirmation/retest sequence, incompatible entry/stop/liquidation/target prices, and a planned loss above $5. Settings are enforced by the server as well as the page. Preview-only checks are available through `preview_strategy_entry`.

Entry reviews start locked after every restart. A preview expires after 60 seconds and is bound to the wallet and current lock state. Editing the form invalidates the visible preview. Enable reviews, confirm the current chart, and request preparation on the wallet page; the server refreshes the checks before requesting a signature. Locking or disconnecting invalidates previews and cancels pending approval. This does not cancel an already submitted transaction or existing orders.

The entry validator currently understands direct USDC short collateral only. It checks the canonical Jupiter program accounts, wallet and keeper signer set, exact collateral and size, adverse fill bound, and the four protective instructions before asking the wallet to sign. **Long entries remain blocked** because the USDC-to-SOL conversion route is not yet validated. A short entry must contain one native instant entry, a whole remaining-position stop, and all three exact-third targets in the same transaction. Unsupported instructions, account destinations, fees, slippage, targets, and existing on-chain positions are rejected before approval. The official entry schema does not document partial-size TP on entry: if the API ignores those fields or returns whole-position targets, validation rejects the transaction. Live compatibility is unverified; funding alone does not make entry ready.

After a submission attempt, further entries stay locked even if the network result is ambiguous. Check the position and protection in Jupiter before any retry. No real submission was performed during setup.

## New MCP tools

- `preview_strategy_entry`: read-only risk preview; requires `side` and `collateral_usdc`. Optional `leverage`, `slippage_bps`, and `holding_hours`.
- `get_strategy_plan`: retrieve the saved plan and its blockers.
- `get_protective_orders`: list connected-wallet SOL positions and native TP/SL requests.
- `set_protective_stop`: create a full remaining-position stop or update one existing full stop. Requires `position` and `stop_price_usd`.
- `set_take_profit_ladder`: create exactly three profit targets with equal original-position notional; the final order receives the micro-USD rounding remainder. Requires `position` and `target_prices_usd`. Requires an existing full stop; rejects existing TP orders to prevent duplication.
- `close_position_partial`: reduce a position by explicit USD notional with bounded slippage. Requires `position` and `size_usd`. Rejects active fixed-size TP orders that would become stale.

Mutation tools default to `dry_run: true`. This prepares, validates and simulates an unsigned transaction; no order is placed. `dry_run: false` opens an approval request on the connected wallet page. Click “Review in Jupiter Wallet”, then approve or reject in the extension. Approvals expire after 45 seconds; expired, changed, replayed, invalid or disconnected requests are rejected.

**Approving native stop/target creation authorizes execution later when triggered, without another wallet popup.** Submission is not confirmation: check the transaction and call `get_protective_orders` before relying on protection. Native triggers are not guaranteed fills or guaranteed loss limits.

The old `open_position` and full `close_position` implementation paths are disabled because they contained placeholder slippage limits. New protective-order tools use Jupiter's official v2 prepare/execute flow. Automatic strategy entries remain disabled; connecting a wallet does not arm the strategy.

## Defensive checks and verification

The server binds only to 127.0.0.1. MCP rejects browser Origin headers. Wallet routes allow only the exact same origin, use HttpOnly/SameSite cookies, require a custom request header for mutations, and use a restrictive content-security policy. Each MCP request has an isolated protocol instance.

Prepared protection transactions are checked for the connected wallet, on-chain ownership, SOL custody, position size and side, requested triggers and sizes, receiving account, supported instructions, slippage bounds, and configured priority-fee ceiling. RPC simulation must succeed before an approval can be requested. The returned wallet signature must sign the original transaction bytes.

`npm run test:e2e` builds the project and runs HTTP/MCP and browser-session end-to-end suites. They use unfunded synthetic wallets and external API/RPC fixtures. Actual submissions are blocked in the fixtures. Tests cover long/short stop previews, updates, equal-third sizing, partial close, unsafe-input rejection, concurrent requests, session/Origin protection, rejected/replayed/unsigned signatures, a valid synthetic signature, and disconnect cancellation. The entry-control suite additionally covers caps and invalid settings, risk including fees and allowances, balance checks, completed-candle freshness, exact-third arithmetic, missing protection, unsafe slippage, lock cancellation, wallet-only review, and submission replay protection. No unit tests or live trades were run.

Jupiter v2 market data and the configured mainnet RPC were checked read-only and returned HTTP 200. The connected wallet successfully returned read-only portfolio and estimate results before this update. Live position simulation, keeper acceptance, entry compatibility, trigger activation and fills remain unverified; fixture success does not prove those outcomes.

The dependency audit has 3 high findings in the bigint-buffer chain. The upstream native implementation is bypassed with its bundled pure-JavaScript implementation before loading Solana dependencies. The reviewed version is pinned/checked. Always launch `dist/index.js`; direct imports of internal modules bypass startup mitigation. npm's version-based advisory remains visible.

References:
- Official Jupiter CLI v2 schema and flow: https://github.com/jup-ag/cli/blob/d8d7386691535469f7d17705ebfc5f432b96feba/src/clients/PerpsClient.ts
- Official perps guide: https://github.com/jup-ag/cli/blob/d8d7386691535469f7d17705ebfc5f432b96feba/docs/perps.md
- Unpatched native dependency advisory: https://github.com/advisories/GHSA-3gc7-fjrx-p6mg

## Candle feed and transaction compatibility

The public `get_candles` and indicator tools use Kraken's SOL/USD, ETH/USD, and XBT/USD spot OHLC feed. Kraken documents that its final row is unfinished, so it is never treated as a completed candle. Responses with missing intervals, invalid prices, or stale current candles fail closed. Entry previews use fresh SOL/USD 15-minute candles and block review when the spot reference differs from the Jupiter Perps mark by more than 25 basis points. The displayed source and spot reference price make this comparison visible. This exchange feed is an independent reference, not Jupiter's oracle or an execution-price guarantee.

The entry transaction validator accepts only a native, direct-USDC SOL short with one exact entry, a whole-position stop, and three exact-third take-profit requests in the same transaction. It rejects unexpected programs, wallets, keeper changes, canonical account changes, collateral amounts, size, fill bounds, fees, leverage, destinations, or missing requests. The official Jupiter v2 entry schema does not document partial target size fields, and an unfunded wallet cannot produce a live prepared transaction for compatibility testing. If the API does not encode all four native requests exactly, entry approval stays blocked. Long entries remain blocked pending validation of the USDC-to-SOL conversion route. No live orders were submitted.

Kraken API documentation: https://docs.kraken.com/api-reference/market-data/get-ohlc-data
## Local Kronos forecasts

The wallet page includes **Kronos · Price scenario**. Choose an asset, candle interval and horizon, then click **Generate forecast**. Wallet connection is not required for forecasting. The solid chart line shows completed closes; the dashed line is the mean of three model-sampled closing-price paths. Forecast prices and their candle-start timestamps are available below the chart.

Install once on Windows with Python 3.13 and Git available:

```powershell
npm run setup:kronos
npm run build
```

Setup downloads the official [Kronos](https://github.com/shiyu-coder/Kronos) source, Kronos-mini weights and 2k tokenizer at the exact revisions in `kronos/manifest.json`. The source, CPU-only Python environment and weights stay under ignored `.runtime/`. Startup does not download anything. Forecasts run offline after public Kraken candles are fetched. The worker inherits no wallet keys or API tokens.

MCP tool: `get_kronos_forecast`, optional arguments:
- `asset`: SOL (default), ETH or BTC.
- `interval`: 5m, 15m (default) or 1h.
- `horizon`: 1–24 candles, default 8.

Each request uses 128 completed Kraken spot USD candles, excludes the unfinished row, and rejects invalid, discontinuous or stale data. Turnover is estimated from base volume times mean OHLC. Inference uses CPU, three sampled paths, seed 42 and a two-minute timeout. One job can run at a time; cancellation stops the child process. Identical inputs can reuse a one-minute cache. The interface shows the generation time and source. Candle timestamps are interval start times, in milliseconds in the MCP response.

This is an experimental closing-price scenario, not a calibrated confidence band or validated SOL trading signal. No backtested profitability claim is made. It does not arm entries, alter the saved strategy, or prepare/sign/submit orders. Spot model outputs are not Jupiter execution quotes.

After installing the runtime, run `npm run test:e2e:kronos` for a full server/MCP test using the actual installed model and fixture market data. `npm run test:e2e` runs the existing wallet and trading-safety scenarios without requiring a model install. No unit tests are used.

## Historical snippets and tuning checks

Use **Check prediction accuracy → Evaluate recent snippets** beneath the Kronos forecast. The asset, interval and forecast horizon come from the controls above. No wallet connection is needed. The same flow is available through MCP `evaluate_kronos` with optional `asset`, `interval` and `horizon` (same defaults and limits as forecasting). Clients should allow up to eight minutes.

The pilot retrieves exactly `128 + 12 × horizon` completed Kraken candles. At the default eight-candle horizon, that is 224 candles. The first 128 provide context. The next six non-overlapping forecast windows select between the existing 128-candle context and a 64-candle context by mean absolute price error. Selection is frozen before scoring the following six windows. The default and selected profile are compared with an unchanged-price baseline on identical held-out labels; if the default is selected, it appears once.

Each inference request receives only the preceding context candles and future timestamps. Actual future prices are retained outside the model worker and scored afterward. Kronos normalizes each context independently. Sampling stays fixed at three paths, seed 42, temperature 1, top-p 0.9. The same pretrained weights are used throughout. This is context-length tuning, not weight fine-tuning.

The report contains:
- MAE and RMSE in USD across all forecast closes (lower is better).
- MAPE: mean absolute percentage price error.
- Endpoint direction matches (up/down/flat relative to the last context close), including the numerator and denominator. Flat means a price difference below 1e-10 USD.
- Mean-error improvement against the unchanged-price baseline and default, or null when the comparison error is zero.
- Per-snippet actual and predicted prices, timestamps, context bounds and the selected profile.

Reports and their exact input candle snapshots are saved locally under ignored `.runtime/kronos-evaluations/`, with dataset hashes, pinned model revisions and sampling settings. The page restores the latest completed report after reload and provides a JSON download. Cancelling leaves the last completed report intact. Test runs use a separate `.runtime/kronos-evaluations-e2e/` directory.

Six held-out windows are an exploratory pilot, not evidence of stable accuracy, profitability or statistical significance. Adjacent windows still share market conditions. A repeatedly viewed holdout becomes development data; a later comparison needs new periods. Historical overlap with the pretrained model's original training data cannot be ruled out. Price accuracy does not measure trading PnL or include costs. No profile is automatically adopted, no model weights are retrained, and wallet controls remain unchanged.

`npm run test:e2e:kronos` now also checks real-model historical evaluation through MCP, recomputed error metrics, chronological separation, persistence, access control and cancellation. No unit tests or real trades run.

## Jev candidate inbox

The **Candidate inbox** on `/wallet` builds a read-only snapshot when you click **Scan candidates**. The same operations are exposed as `scan_trade_candidates` and `get_candidate_inbox` MCP tools. Market data, completed Kraken candles for SOL/ETH/BTC and 1-hour SOL context, local RSI/EMA/ATR, Kronos's SOL forecast, the saved Kronos evaluation summary, and the saved SOL plan are collected. Independent feeds run in parallel, with source and timestamps retained. Missing inputs are explicit warnings; stale SOL candles prevent hosted ranking.

Configure the hosted selector in the **OpenRouter API key** password field on `/wallet`, or set `OPENROUTER_API_KEY` in the ignored local `.env` file. The local form requires the page's session and same-origin request header, saves the key to `.env`, updates the running process, clears the input, and returns only configured status. The integration calls OpenRouter's TypeSafe-compatible `POST /api/v1/systemone` with the pinned `jev-1.13` model. The key remains server-side and is never returned to the browser. The hosted request contains public market summaries, the saved plan levels and candidate descriptions. It excludes wallet addresses, balances, private keys and transaction data.

One Jev request asks a Choice among `sol_long`, `sol_short`, `eth_watch`, `btc_watch`, and `none`, plus a Noul evidence-consistency question. The server validates every choice and probability, and treats an invalid response as a failed scan. Jev probabilities are shown as shares across review options, not chances of profit. A low-consistency, low-confidence or `none` decision routes to **watch**. ETH/BTC remain analysis only because no reviewed entry plan exists for them.

A selected SOL candidate displays **Review in entry controls** until its snapshot expires. The button selects the corresponding saved setup and requests a fresh entry preview when the wallet is connected. It does not unlock entries, confirm a chart pattern, prepare a transaction, or sign. The existing $5 planned-risk cap, leverage range, balance checks, atomic stop/three-target validator and Jupiter Wallet approval remain mandatory. Long entries remain blocked until their conversion route is validated.

Each scan and its detailed state are stored in ignored `.runtime/candidate-inbox/`. The page restores the latest scan and offers a JSON download. Use a new scan after a candle closes; an expired result cannot be sent to entry review. The **Check eight-candle outcome** control records the subsequent completed SOL spot close once available and compares its direction with a selected SOL long or short. It records an observed market move, not a trade result or realized PnL. Repeated scans and outcomes can support later selector evaluation; this system does not claim the selector improves trading results. Run `npm run test:e2e:candidates` for the full fixture-backed workflow. No unit tests or real orders are used.

For a live-data historical replay, run `npm run test:e2e:history`. It fetches completed Kraken SOL/ETH/BTC 15-minute and SOL hourly candles, generates six past-only local Kronos forecasts, and asks the same Jev choice validator to rank candidates at six spaced historical decision points. The next eight candles are hidden until each decision is recorded and then used to score SOL spot direction. The report is saved in ignored `.runtime/candidate-history/latest.json`. The summary counts abstentions and SOL direction calls separately. This is a research replay, not a fill or PnL backtest: it has no historical Jupiter liquidity, borrowing costs, wallet state, entry confirmation, or execution data. Six windows cannot establish predictive reliability, and the existing SOL plan may reflect hindsight for these historical dates. A later, untouched period is needed before using results to adjust any trading rule.

Jev protocol references: https://docs.typesafe.ai/concepts/system-one and https://openrouter.ai/docs/guides/community/typesafe-sdk
