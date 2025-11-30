/**
 * Type definitions for Jupiter Perps API responses and tool outputs
 */

// ==================== Jupiter API Response Types ====================

/**
 * Response from /pool-info endpoint
 */
export interface PoolInfoResponse {
  longAvailableLiquidity: string;
  longBorrowRatePercent: string;
  longUtilizationPercent: string;
  shortAvailableLiquidity: string;
  shortBorrowRatePercent: string;
  shortUtilizationPercent: string;
  openFeePercent: string;
  maxRequestExecutionSec: string;
  maxPriceImpactFeePercent: string;
}

/**
 * Response from /market-stats endpoint
 */
export interface MarketStatsResponse {
  price: string;
  priceChange24H: string;
  priceHigh24H: string;
  priceLow24H: string;
  volume: string;
}

// ==================== Tool Output Types ====================

/**
 * Market snapshot for a single asset
 */
export interface MarketState {
  asset: string;
  index_price: number;
  stats_24h: {
    change_pct: number;
    high: number;
    low: number;
    volume_usd: number;
  };
  fees: {
    base_fee_pct: number;
    max_price_impact_pct: number;
  };
  long_side: {
    hourly_borrow_rate_pct: number;
    utilization_pct: number;
    available_liquidity_usd: number;
  };
  short_side: {
    hourly_borrow_rate_pct: number;
    utilization_pct: number;
    available_liquidity_usd: number;
  };
}

/**
 * Complete market snapshot output
 */
export interface MarketSnapshotOutput {
  timestamp_unix: number;
  markets: MarketState[];
}

// ==================== Position Types ====================

export type PositionSide = "Long" | "Short";

export interface FeesToClose {
  accrued_borrow_fee_usd: number;
  estimated_close_fee_usd: number;
  estimated_price_impact_usd: number;
}

export interface Position {
  asset: string;
  side: PositionSide;
  collateral_usd: number;
  equity_usd: number;
  leverage: number;
  size_usd: number;
  entry_price: number;
  mark_price: number;
  liquidation_price: number;
  fees_to_close: FeesToClose;
}

// ==================== API Response Types for Positions ====================

/**
 * Response from /v1/positions endpoint
 */
export interface PositionsApiResponse {
  count: number;
  dataList: PositionApiData[];
}

export interface PositionApiData {
  borrowFees: string;
  borrowFeesUsd: string;
  closeFees: string;
  closeFeesUsd: string;
  collateral: string;
  collateralUsd: string;
  collateralMint: string;
  createdTime: number;
  entryPrice: string;
  leverage: string;
  liquidationPrice: string;
  marketMint: string;
  markPrice: string;
  openFees: string;
  openFeesUsd: string;
  pnlAfterFees: string;
  pnlAfterFeesUsd: string;
  pnlBeforeFees: string;
  pnlBeforeFeesUsd: string;
  pnlChangePctAfterFees: string;
  pnlChangePctBeforeFees: string;
  positionPubkey: string;
  side: string;
  size: string;
  sizeUsdDelta: string;
  sizeTokenAmount: string;
  totalFees: string;
  totalFeesUsd: string;
  tpslRequests: any[];
  updatedTime: number;
  value: string;
}

/**
 * Response from /v1/positions-gasless/decrease endpoint
 */
export interface DecreasePositionQuoteResponse {
  quote: {
    closeFeeUsd: string;
    feeUsd: string;
    leverage: string;
    liquidationPriceUsd: string;
    outstandingBorrowFeeUsd: string;
    pnlAfterFees: string;
    pnlAfterFeesPercent: string;
    pnlAfterFeesUsd: string;
    pnlBeforeFees: string;
    pnlBeforeFeesPercent: string;
    pnlBeforeFeesUsd: string;
    priceImpactFeeBps: string;
    priceImpactFeeUsd: string;
    positionCollateralSizeUsd: string;
    positionSizeUsd: string;
    side: string;
    transferTokenMint: string;
    transferAmountToken: string;
    transferAmountUsd: string;
  };
  positionPubkey: string;
  positionRequestPubkey: string | null;
  requireKeeperSignature: boolean;
  serializedTxBase64: string;
  txMetadata: {
    blockhash: string;
    lastValidBlockHeight: string;
    transactionFeeLamports: string;
    accountRentLamports: string;
  };
}

/**
 * Response from ultra-api holdings endpoint
 */
export interface HoldingsApiResponse {
  amount: string;
  uiAmount: number;
  uiAmountString: string;
  tokens: {
    [mintAddress: string]: TokenHolding[];
  };
}

export interface TokenHolding {
  account: string;
  amount: string;
  uiAmount: number;
  uiAmountString: string;
  isFrozen: boolean;
  isAssociatedTokenAccount: boolean;
  decimals: number;
  programId: string;
  excludeFromNetWorth: boolean;
}

// ==================== Account Types ====================

export interface AccountPortfolio {
  timestamp_unix: number;
  usdc_balance: number;
  total_equity: number;
  positions: Position[];
}

// ==================== Candle Types ====================

/**
 * Supported candle intervals
 */
export type CandleInterval = "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

/**
 * Single OHLCV candle data point
 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Response from Oracle Security history API
 */
export interface CandlesApiResponse {
  result: Candle[];
}

/**
 * Candles output for get_candles tool
 */
export interface CandlesOutput {
  asset: string;
  interval: CandleInterval;
  data: Candle[];
}

// ==================== Position Estimation Types ====================

/**
 * Response from /v1/positions/increase endpoint
 */
export interface IncreasePositionResponse {
  quote: {
    collateralLessThanFees: boolean;
    entryPriceUsd: string;
    leverage: string;
    liquidationPriceUsd: string;
    openFeeUsd: string;
    outstandingBorrowFeeUsd: string;
    priceImpactFeeUsd: string;
    priceImpactFeeBps: string;
    positionCollateralSizeUsd: string;
    positionSizeUsd: string;
    positionSizeTokenAmount: string;
    quoteOutAmount: string | null;
    quotePriceSlippagePct: string | null;
    quoteSlippageBps: string | null;
    side: string;
    expectedSizeUsdDelta: string;
    expectedSizeUsdDeltaDiffPct: string;
    sizeUsdDelta: string;
    sizeUsdDeltaRaw: string;
    sizeTokenDelta: string;
  };
  serializedTxBase64: string | null;
  positionPubkey: string;
  positionRequestPubkey: string | null;
  txMetadata: any;
  transactionType: string;
  requireKeeperSignature: boolean;
  tpslRequests: any[];
}

/**
 * Fees to pay for estimate_open_position output
 */
export interface FeesToPay {
  open_fee_usd: number;
  price_impact_fee_usd: number;
  borrow_fees_to_settle_usd: number;
}

/**
 * Resulting position information for estimate_open_position output
 */
export interface ResultingPosition {
  average_entry_price: number;
  total_size_usd: number;
  total_collateral_usd: number;
  leverage: number;
  liquidation_price: number;
}

/**
 * Complete estimate_open_position output
 */
export interface EstimateOpenPositionOutput {
  timestamp_unix: number;
  fees_to_pay: FeesToPay;
  resulting_position: ResultingPosition;
}
