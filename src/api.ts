/**
 * Jupiter Perps API client utilities
 */

import {
  JUPITER_API,
  TOKENS,
  TokenSymbol,
  ULTRA_API,
  USDC_MINT_ADDRESS,
} from "./constants.js";
import { fetchKrakenCandles } from "./services/candle-feed.js";
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

/** Fetch validated, completed public spot candles. */
export async function fetchCandles(asset: string, interval: CandleInterval, limit: number): Promise<CandlesApiResponse> {
  return fetchKrakenCandles(asset, interval, limit);
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
