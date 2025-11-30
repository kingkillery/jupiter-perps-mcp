/**
 * Position estimation service
 * Handles estimating position opens/increases
 */

import { fetchIncreaseEstimate } from "../api.js";
import { EstimateOpenPositionOutput } from "../types.js";

/**
 * Estimate opening or increasing a position
 * @param walletAddress - Wallet public address
 * @param asset - Asset symbol (SOL, ETH, BTC)
 * @param side - Trade side (Long or Short)
 * @param collateralAmount - USDC collateral amount
 * @param leverage - Leverage multiplier
 * @param maxSlippageBps - Maximum slippage in basis points
 */
export async function estimateOpenPosition(
  walletAddress: string,
  asset: string,
  side: "Long" | "Short",
  collateralAmount: number,
  leverage: number,
  maxSlippageBps: number
): Promise<EstimateOpenPositionOutput> {
  // Fetch estimate from API
  const response = await fetchIncreaseEstimate(
    walletAddress,
    asset,
    side,
    collateralAmount,
    leverage,
    maxSlippageBps
  );

  const quote = response.quote;

  // Transform to output format
  return {
    timestamp_unix: Math.floor(Date.now() / 1000),
    fees_to_pay: {
      open_fee_usd: parseFloat(quote.openFeeUsd),
      price_impact_fee_usd: parseFloat(quote.priceImpactFeeUsd),
      borrow_fees_to_settle_usd: parseFloat(quote.outstandingBorrowFeeUsd),
    },
    resulting_position: {
      average_entry_price: parseFloat(quote.entryPriceUsd),
      total_size_usd: parseFloat(quote.positionSizeUsd),
      total_collateral_usd: parseFloat(quote.positionCollateralSizeUsd),
      leverage: parseFloat(quote.leverage),
      liquidation_price: parseFloat(quote.liquidationPriceUsd),
    },
  };
}
