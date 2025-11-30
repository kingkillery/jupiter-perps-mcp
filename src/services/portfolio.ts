/**
 * Portfolio service
 * Handles fetching and transforming account portfolio data
 */

import { fetchHoldings, fetchPositions, fetchDecreaseQuote } from "../api.js";
import { getTokenByMint, USDC_MINT_ADDRESS } from "../constants.js";
import { AccountPortfolio, Position, PositionSide } from "../types.js";

/**
 * Extract USDC balance from holdings response
 */
function extractUsdcBalance(holdings: any): number {
  // Check if USDC token exists in holdings
  const usdcHoldings = holdings.tokens[USDC_MINT_ADDRESS];

  if (!usdcHoldings || !Array.isArray(usdcHoldings) || usdcHoldings.length === 0) {
    return 0;
  }

  // Sum up all USDC holdings (usually just one account)
  return usdcHoldings.reduce((total: number, holding: any) => {
    return total + (holding.uiAmount || 0);
  }, 0);
}

/**
 * Transform API position data to our Position format
 */
async function transformPosition(positionData: any): Promise<Position> {
  // Get asset symbol from market mint
  const token = getTokenByMint(positionData.marketMint);
  const asset = token ? token.symbol : "UNKNOWN";

  // Fetch decrease quote to get price impact fee
  const decreaseQuote = await fetchDecreaseQuote(
    positionData.positionPubkey,
    positionData.marketMint
  );

  // Capitalize side: "long" -> "Long", "short" -> "Short"
  const side: PositionSide =
    positionData.side.toLowerCase() === "long" ? "Long" : "Short";

  return {
    asset,
    side,
    // collateralUsd is in micro-dollars (raw units), divide by 1M to get USD
    collateral_usd: parseFloat(positionData.collateralUsd) / 1_000_000,
    equity_usd: parseFloat(positionData.value),
    leverage: parseFloat(positionData.leverage),
    size_usd: parseFloat(positionData.size),
    entry_price: parseFloat(positionData.entryPrice),
    mark_price: parseFloat(positionData.markPrice),
    liquidation_price: parseFloat(positionData.liquidationPrice),
    fees_to_close: {
      accrued_borrow_fee_usd: parseFloat(positionData.borrowFeesUsd),
      estimated_close_fee_usd: parseFloat(positionData.closeFeesUsd),
      estimated_price_impact_usd: parseFloat(decreaseQuote.quote.priceImpactFeeUsd),
    },
  };
}

/**
 * Cross-validate position data with decrease quote
 * Logs warnings if values don't match
 */
function crossValidatePosition(positionData: any, decreaseQuote: any): void {
  const positionBorrowFee = parseFloat(positionData.borrowFeesUsd);
  const quoteBorrowFee = parseFloat(decreaseQuote.quote.outstandingBorrowFeeUsd);

  // Allow small tolerance for floating point differences
  const tolerance = 0.01;

  if (Math.abs(positionBorrowFee - quoteBorrowFee) > tolerance) {
    console.warn(
      `Borrow fee mismatch for position ${positionData.positionPubkey}: ` +
      `position=${positionBorrowFee}, quote=${quoteBorrowFee}`
    );
  }

  const positionCloseFee = parseFloat(positionData.closeFeesUsd);
  const quoteCloseFee = parseFloat(decreaseQuote.quote.closeFeeUsd);

  if (Math.abs(positionCloseFee - quoteCloseFee) > tolerance) {
    console.warn(
      `Close fee mismatch for position ${positionData.positionPubkey}: ` +
      `position=${positionCloseFee}, quote=${quoteCloseFee}`
    );
  }
}

/**
 * Get account portfolio including USDC balance and positions
 */
export async function getAccountPortfolio(walletAddress: string): Promise<AccountPortfolio> {
  // Fetch all data in parallel
  const [holdings, positionsResponse] = await Promise.all([
    fetchHoldings(walletAddress),
    fetchPositions(walletAddress),
  ]);

  // Extract USDC balance
  const usdcBalance = extractUsdcBalance(holdings);

  // Transform positions (this will fetch decrease quotes for each position)
  const positionsPromises = positionsResponse.dataList.map(async (positionData) => {
    const position = await transformPosition(positionData);

    // Cross-validate with decrease quote (optional, for debugging)
    const decreaseQuote = await fetchDecreaseQuote(
      positionData.positionPubkey,
      positionData.marketMint
    );
    crossValidatePosition(positionData, decreaseQuote);

    return position;
  });

  const positions = await Promise.all(positionsPromises);

  // Calculate total equity: USDC balance + sum of position equities
  const totalPositionEquity = positions.reduce((sum, pos) => sum + pos.equity_usd, 0);
  const totalEquity = usdcBalance + totalPositionEquity;

  return {
    timestamp_unix: Math.floor(Date.now() / 1000),
    usdc_balance: usdcBalance,
    total_equity: totalEquity,
    positions,
  };
}
