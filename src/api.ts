/**
 * Jupiter Perps API client utilities
 */

import {
  JUPITER_API,
  TOKENS,
  TokenSymbol,
  CANDLES_API,
  INTERVAL_MAPPING,
  ASSET_FEED_MAPPING,
  ULTRA_API,
  USDC_MINT_ADDRESS,
} from "./constants.js";
import {
  PoolInfoResponse,
  MarketStatsResponse,
  CandlesApiResponse,
  CandleInterval,
  PositionsApiResponse,
  DecreasePositionQuoteResponse,
  HoldingsApiResponse,
  IncreasePositionResponse,
} from "./types.js";

/**
 * Validate pool info response has required fields
 */
function validatePoolInfo(data: any, symbol: string): asserts data is PoolInfoResponse {
  const requiredFields = [
    "longAvailableLiquidity",
    "longBorrowRatePercent",
    "longUtilizationPercent",
    "shortAvailableLiquidity",
    "shortBorrowRatePercent",
    "shortUtilizationPercent",
    "openFeePercent",
    "maxPriceImpactFeePercent",
  ];

  for (const field of requiredFields) {
    if (!(field in data)) {
      throw new Error(`Invalid pool info response for ${symbol}: missing field '${field}'`);
    }
    if (typeof data[field] !== "string") {
      throw new Error(`Invalid pool info response for ${symbol}: field '${field}' must be a string`);
    }
  }

  // Validate that numeric strings are actually parseable and non-negative
  for (const field of requiredFields) {
    const value = parseFloat(data[field]);
    if (isNaN(value)) {
      throw new Error(`Invalid pool info response for ${symbol}: field '${field}' is not a valid number`);
    }
    if (value < 0) {
      throw new Error(`Invalid pool info response for ${symbol}: field '${field}' cannot be negative`);
    }
  }
}

/**
 * Fetch pool info for a specific token
 */
export async function fetchPoolInfo(symbol: TokenSymbol): Promise<PoolInfoResponse> {
  const token = TOKENS[symbol];
  const url = `${JUPITER_API.BASE_URL}${JUPITER_API.ENDPOINTS.POOL_INFO}?mint=${token.mint.toBase58()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch pool info for ${symbol}: ${response.statusText}`);
  }

  const data = await response.json();
  validatePoolInfo(data, symbol);

  return data;
}

/**
 * Validate market stats response has required fields
 */
function validateMarketStats(data: any, symbol: string): asserts data is MarketStatsResponse {
  const requiredFields = ["price", "priceChange24H", "priceHigh24H", "priceLow24H", "volume"];

  for (const field of requiredFields) {
    if (!(field in data)) {
      throw new Error(`Invalid market stats response for ${symbol}: missing field '${field}'`);
    }
    if (typeof data[field] !== "string") {
      throw new Error(`Invalid market stats response for ${symbol}: field '${field}' must be a string`);
    }
  }

  // Validate that numeric strings are actually parseable
  const numericFields = ["price", "priceChange24H", "priceHigh24H", "priceLow24H", "volume"];
  for (const field of numericFields) {
    const value = parseFloat(data[field]);
    if (isNaN(value)) {
      throw new Error(`Invalid market stats response for ${symbol}: field '${field}' is not a valid number`);
    }
  }
}

/**
 * Fetch market stats for a specific token
 */
export async function fetchMarketStats(symbol: TokenSymbol): Promise<MarketStatsResponse> {
  const token = TOKENS[symbol];
  const url = `${JUPITER_API.BASE_URL}${JUPITER_API.ENDPOINTS.MARKET_STATS}?mint=${token.mint.toBase58()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch market stats for ${symbol}: ${response.statusText}`);
  }

  const data = await response.json();
  validateMarketStats(data, symbol);

  return data;
}

/**
 * Fetch both pool info and market stats for a token
 */
export async function fetchMarketData(symbol: TokenSymbol): Promise<{
  poolInfo: PoolInfoResponse;
  marketStats: MarketStatsResponse;
}> {
  const [poolInfo, marketStats] = await Promise.all([
    fetchPoolInfo(symbol),
    fetchMarketStats(symbol),
  ]);

  return { poolInfo, marketStats };
}

/**
 * Issue found during candle validation
 */
interface CandleValidationIssue {
  candleIndex: number;
  timestamp: number;
  issueType: string;
  originalValues: { open: number; high: number; low: number; close: number };
  fixedValues?: { open: number; high: number; low: number; close: number };
  autoFixed: boolean;
  errorMessage: string;
}

/**
 * Auto-fix OHLC violations in candle data
 * Always fixes high/low violations regardless of magnitude
 * Returns fixed candles and a list of issues found
 */
function autoFixCandles(
  candles: any[],
  asset: string
): { candles: any[]; issues: CandleValidationIssue[] } {
  const issues: CandleValidationIssue[] = [];

  const fixedCandles = candles.map((candle, index) => {
    const fixed = { ...candle };

    // Check high < open - always auto-fix
    if (candle.high < candle.open) {
      const diff = candle.open - candle.high;
      fixed.high = candle.open;
      issues.push({
        candleIndex: index,
        timestamp: candle.time,
        issueType: "high_below_open",
        originalValues: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
        fixedValues: { open: fixed.open, high: fixed.high, low: fixed.low, close: fixed.close },
        autoFixed: true,
        errorMessage: `High (${candle.high}) < Open (${candle.open}) - auto-fixed by setting high = ${fixed.high} (diff: ${diff.toFixed(4)})`
      });
    }

    // Check high < close - always auto-fix
    if (candle.high < candle.close) {
      const diff = candle.close - candle.high;
      fixed.high = Math.max(fixed.high, candle.close);
      issues.push({
        candleIndex: index,
        timestamp: candle.time,
        issueType: "high_below_close",
        originalValues: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
        fixedValues: { open: fixed.open, high: fixed.high, low: fixed.low, close: fixed.close },
        autoFixed: true,
        errorMessage: `High (${candle.high}) < Close (${candle.close}) - auto-fixed by setting high = ${fixed.high} (diff: ${diff.toFixed(4)})`
      });
    }

    // Check low > open - always auto-fix
    if (candle.low > candle.open) {
      const diff = candle.low - candle.open;
      fixed.low = candle.open;
      issues.push({
        candleIndex: index,
        timestamp: candle.time,
        issueType: "low_above_open",
        originalValues: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
        fixedValues: { open: fixed.open, high: fixed.high, low: fixed.low, close: fixed.close },
        autoFixed: true,
        errorMessage: `Low (${candle.low}) > Open (${candle.open}) - auto-fixed by setting low = ${fixed.low} (diff: ${diff.toFixed(4)})`
      });
    }

    // Check low > close - always auto-fix
    if (candle.low > candle.close) {
      const diff = candle.low - candle.close;
      fixed.low = Math.min(fixed.low, candle.close);
      issues.push({
        candleIndex: index,
        timestamp: candle.time,
        issueType: "low_above_close",
        originalValues: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
        fixedValues: { open: fixed.open, high: fixed.high, low: fixed.low, close: fixed.close },
        autoFixed: true,
        errorMessage: `Low (${candle.low}) > Close (${candle.close}) - auto-fixed by setting low = ${fixed.low} (diff: ${diff.toFixed(4)})`
      });
    }

    return fixed;
  });

  return { candles: fixedCandles, issues };
}

/**
 * Validate candle data response and auto-fix minor OHLC errors
 */
function validateCandlesResponse(
  data: any,
  asset: string,
  interval: CandleInterval
): asserts data is CandlesApiResponse {
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid candles response for ${asset}: response is not an object`);
  }

  if (!("result" in data)) {
    throw new Error(`Invalid candles response for ${asset}: missing 'result' field`);
  }

  if (!Array.isArray(data.result)) {
    throw new Error(`Invalid candles response for ${asset}: 'result' is not an array`);
  }

  if (data.result.length === 0) {
    throw new Error(`Invalid candles response for ${asset}: 'result' array is empty`);
  }

  // Validate candle structure for the first candle (sample check)
  const firstCandle = data.result[0];
  const requiredFields = ["time", "open", "high", "low", "close", "volume"];

  for (const field of requiredFields) {
    if (!(field in firstCandle)) {
      throw new Error(`Invalid candle data for ${asset}: missing field '${field}'`);
    }
    if (typeof firstCandle[field] !== "number") {
      throw new Error(`Invalid candle data for ${asset}: field '${field}' must be a number`);
    }
  }

  // Auto-fix OHLC violations for ALL candles
  const { candles: fixedCandles, issues } = autoFixCandles(data.result, asset);

  // Log any issues found (both auto-fixed and unfixable)
  if (issues.length > 0) {
    console.warn(`\n=== Candle Data Issues for ${asset} (${interval}) ===`);
    console.warn(`Total issues found: ${issues.length}`);
    console.warn(`Auto-fixed: ${issues.filter(i => i.autoFixed).length}`);
    console.warn(`Failed to fix: ${issues.filter(i => !i.autoFixed).length}\n`);

    issues.forEach(issue => {
      const prefix = issue.autoFixed ? "✓ AUTO-FIXED" : "✗ FAILED";
      console.warn(`${prefix} [Index ${issue.candleIndex}, Time ${issue.timestamp}]:`);
      console.warn(`  ${issue.errorMessage}`);
      console.warn(`  Original: O=${issue.originalValues.open} H=${issue.originalValues.high} L=${issue.originalValues.low} C=${issue.originalValues.close}`);
      if (issue.fixedValues) {
        console.warn(`  Fixed:    O=${issue.fixedValues.open} H=${issue.fixedValues.high} L=${issue.fixedValues.low} C=${issue.fixedValues.close}`);
      }
    });
    console.warn("===========================================\n");
  }

  // Replace data with fixed candles
  data.result = fixedCandles;

  // Validate time ordering and interval consistency
  if (data.result.length > 1) {
    const expectedIntervalMs = getIntervalMilliseconds(interval);
    // Allow 10% tolerance for interval variations (e.g., missing candles, slight timing differences)
    const toleranceMs = expectedIntervalMs * 0.1;

    for (let i = 1; i < data.result.length; i++) {
      const prevCandle = data.result[i - 1];
      const currentCandle = data.result[i];

      // Check time ordering (should be ascending)
      if (currentCandle.time <= prevCandle.time) {
        throw new Error(
          `Invalid candle data for ${asset}: candles are not in chronological order at index ${i}`
        );
      }

      // Check interval consistency (allow for missing candles by checking if diff is a multiple of expected interval)
      const timeDiff = currentCandle.time - prevCandle.time;
      const intervalMultiplier = Math.round(timeDiff / expectedIntervalMs);

      // If the multiplier is not close to an integer or is 0, the interval is inconsistent
      if (intervalMultiplier === 0) {
        throw new Error(
          `Invalid candle data for ${asset}: time difference too small between candles at index ${i}`
        );
      }

      // Check if the actual difference is close to a multiple of the expected interval
      const expectedDiff = intervalMultiplier * expectedIntervalMs;
      const diffError = Math.abs(timeDiff - expectedDiff);

      if (diffError > toleranceMs) {
        throw new Error(
          `Invalid candle data for ${asset}: unexpected time interval at index ${i} ` +
          `(expected ~${intervalMultiplier * expectedIntervalMs}ms, got ${timeDiff}ms)`
        );
      }
    }
  }
}

/**
 * Fetch historical candle data for an asset
 * @param asset - Asset symbol (SOL, ETH, BTC)
 * @param interval - Candle interval (5m, 15m, 1h, 4h, 1d, 1w)
 * @param limit - Number of candles to retrieve (1-500)
 */
export async function fetchCandles(
  asset: string,
  interval: CandleInterval,
  limit: number
): Promise<CandlesApiResponse> {
  // Validate asset
  const feed = ASSET_FEED_MAPPING[asset.toUpperCase()];
  if (!feed) {
    throw new Error(
      `Unsupported asset for candles: ${asset}. Supported: ${Object.keys(ASSET_FEED_MAPPING).join(", ")}`
    );
  }

  // Map interval to API format
  const apiInterval = INTERVAL_MAPPING[interval];
  if (!apiInterval) {
    throw new Error(
      `Unsupported interval: ${interval}. Supported: ${Object.keys(INTERVAL_MAPPING).join(", ")}`
    );
  }

  // Calculate time range
  // Get current time and go back enough to fetch the requested number of candles
  const now = Date.now();
  const intervalMs = getIntervalMilliseconds(interval);
  const from = now - intervalMs * limit;

  const url = `${CANDLES_API.BASE_URL}?feed=${feed}&type=${apiInterval}&from=${from}&till=${now}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch candles for ${asset}: ${response.statusText}`);
  }

  const data = await response.json();

  // Validate response structure and time intervals
  validateCandlesResponse(data, asset, interval);

  // Limit the results to the requested number
  if (data.result.length > limit) {
    data.result = data.result.slice(-limit);
  }

  return data;
}

/**
 * Helper function to convert interval to milliseconds
 */
function getIntervalMilliseconds(interval: CandleInterval): number {
  const intervals: Record<CandleInterval, number> = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
  };
  return intervals[interval];
}

// ==================== Portfolio API Functions ====================

/**
 * Validate holdings response
 */
function validateHoldingsResponse(data: any, walletAddress: string): asserts data is HoldingsApiResponse {
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid holdings response for ${walletAddress}: response is not an object`);
  }

  if (!("tokens" in data) || typeof data.tokens !== "object") {
    throw new Error(`Invalid holdings response for ${walletAddress}: missing or invalid 'tokens' field`);
  }
}

/**
 * Fetch wallet holdings (USDC balance)
 */
export async function fetchHoldings(walletAddress: string): Promise<HoldingsApiResponse> {
  const url = `${ULTRA_API.BASE_URL}${ULTRA_API.ENDPOINTS.HOLDINGS}/${walletAddress}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch holdings for ${walletAddress}: ${response.statusText}`);
  }

  const data = await response.json();
  validateHoldingsResponse(data, walletAddress);

  return data;
}

/**
 * Validate positions response
 */
function validatePositionsResponse(data: any, walletAddress: string): asserts data is PositionsApiResponse {
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid positions response for ${walletAddress}: response is not an object`);
  }

  if (!("dataList" in data) || !Array.isArray(data.dataList)) {
    throw new Error(`Invalid positions response for ${walletAddress}: missing or invalid 'dataList' field`);
  }

  if (!("count" in data) || typeof data.count !== "number") {
    throw new Error(`Invalid positions response for ${walletAddress}: missing or invalid 'count' field`);
  }

  // Validate first position structure if any exist
  if (data.dataList.length > 0) {
    const firstPosition = data.dataList[0];
    const requiredFields = [
      "positionPubkey",
      "side",
      "marketMint",
      "collateralUsd",
      "value",
      "size",
      "entryPrice",
      "markPrice",
      "liquidationPrice",
      "leverage",
      "openFeesUsd",
      "borrowFeesUsd",
      "closeFeesUsd",
    ];

    for (const field of requiredFields) {
      if (!(field in firstPosition)) {
        throw new Error(`Invalid position data for ${walletAddress}: missing field '${field}'`);
      }
    }
  }
}

/**
 * Fetch user positions
 */
export async function fetchPositions(walletAddress: string): Promise<PositionsApiResponse> {
  const url = `${JUPITER_API.BASE_URL}${JUPITER_API.ENDPOINTS.POSITIONS}?walletAddress=${walletAddress}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch positions for ${walletAddress}: ${response.statusText}`);
  }

  const data = await response.json();
  validatePositionsResponse(data, walletAddress);

  return data;
}

/**
 * Validate decrease position quote response
 */
function validateDecreaseQuoteResponse(
  data: any,
  positionPubkey: string
): asserts data is DecreasePositionQuoteResponse {
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid decrease quote response for ${positionPubkey}: response is not an object`);
  }

  if (!("quote" in data) || typeof data.quote !== "object") {
    throw new Error(`Invalid decrease quote response for ${positionPubkey}: missing or invalid 'quote' field`);
  }

  const requiredQuoteFields = [
    "closeFeeUsd",
    "priceImpactFeeUsd",
    "outstandingBorrowFeeUsd",
  ];

  for (const field of requiredQuoteFields) {
    if (!(field in data.quote)) {
      throw new Error(`Invalid decrease quote for ${positionPubkey}: missing field 'quote.${field}'`);
    }
  }
}

/**
 * Fetch decrease position quote to get estimated price impact fee
 */
export async function fetchDecreaseQuote(
  positionPubkey: string,
  marketMint: string
): Promise<DecreasePositionQuoteResponse> {
  const url = `${JUPITER_API.BASE_URL}${JUPITER_API.ENDPOINTS.DECREASE_POSITION}`;

  const payload = {
    positionPubkey,
    desiredMint: marketMint,
    sizeUsdDelta: "0",
    collateralUsdDelta: "0",
    entirePosition: true,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch decrease quote for ${positionPubkey}: ${response.statusText}`);
  }

  const data = await response.json();
  validateDecreaseQuoteResponse(data, positionPubkey);

  return data;
}

/**
 * Validate increase position response
 */
function validateIncreasePositionResponse(
  data: any,
  params: string
): asserts data is IncreasePositionResponse {
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid increase position response for ${params}: response is not an object`);
  }

  if (!("quote" in data) || typeof data.quote !== "object") {
    throw new Error(`Invalid increase position response for ${params}: missing or invalid 'quote' field`);
  }

  const requiredQuoteFields = [
    "entryPriceUsd",
    "leverage",
    "liquidationPriceUsd",
    "openFeeUsd",
    "outstandingBorrowFeeUsd",
    "priceImpactFeeUsd",
    "positionCollateralSizeUsd",
    "positionSizeUsd",
    "sizeUsdDelta",
  ];

  for (const field of requiredQuoteFields) {
    if (!(field in data.quote)) {
      throw new Error(`Invalid increase position response for ${params}: missing field 'quote.${field}'`);
    }
  }
}

/**
 * Fetch increase position estimate
 * @param walletAddress - Wallet public address
 * @param asset - Asset symbol (SOL, ETH, BTC)
 * @param side - Trade side (Long or Short)
 * @param collateralAmount - USDC collateral amount
 * @param leverage - Leverage multiplier
 * @param maxSlippageBps - Maximum slippage in basis points
 */
export async function fetchIncreaseEstimate(
  walletAddress: string,
  asset: string,
  side: "Long" | "Short",
  collateralAmount: number,
  leverage: number,
  maxSlippageBps: number
): Promise<IncreasePositionResponse> {
  const url = `${JUPITER_API.BASE_URL}${JUPITER_API.ENDPOINTS.INCREASE_POSITION}`;

  // Get token info
  const token = TOKENS[asset.toUpperCase() as TokenSymbol];
  if (!token) {
    throw new Error(`Unsupported asset: ${asset}`);
  }

  // Convert side to lowercase for API
  const apiSide = side.toLowerCase();

  // For Long positions, collateral is the market asset
  // For Short positions, collateral is USDC
  const collateralMint = apiSide === "long" ? token.mint.toBase58() : USDC_MINT_ADDRESS;

  // Convert collateral amount to token units (USDC has 6 decimals)
  const collateralTokenDelta = Math.floor(collateralAmount * 1_000_000).toString();

  const payload = {
    walletAddress,
    marketMint: token.mint.toBase58(),
    inputMint: USDC_MINT_ADDRESS,
    collateralMint,
    side: apiSide,
    leverage: leverage.toString(),
    maxSlippageBps: maxSlippageBps.toString(),
    collateralTokenDelta,
    includeSerializedTx: false,
    tpsl: [],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch increase estimate: ${response.statusText}`);
  }

  const data = await response.json();
  const paramStr = `${asset} ${side} ${collateralAmount} USDC @ ${leverage}x`;
  validateIncreasePositionResponse(data, paramStr);

  return data;
}
