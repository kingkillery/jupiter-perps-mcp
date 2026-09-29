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