/**
 * Market data service
 * Handles fetching and transforming market data
 */

import { getTradingAssets } from "../constants.js";
import { fetchMarketData } from "../api.js";
import { MarketState, MarketSnapshotOutput } from "../types.js";

/**
 * Transform API responses into MarketState format
 */
function transformMarketState(
  symbol: string,
  poolInfo: any,
  marketStats: any
): MarketState {
  return {
    asset: symbol,
    index_price: parseFloat(marketStats.price),
    stats_24h: {
      change_pct: parseFloat(marketStats.priceChange24H),
      high: parseFloat(marketStats.priceHigh24H),
      low: parseFloat(marketStats.priceLow24H),
      volume_usd: parseFloat(marketStats.volume),
    },
    fees: {
      base_fee_pct: parseFloat(poolInfo.openFeePercent),
      max_price_impact_pct: parseFloat(poolInfo.maxPriceImpactFeePercent),
    },
    long_side: {
      hourly_borrow_rate_pct: parseFloat(poolInfo.longBorrowRatePercent),
      utilization_pct: parseFloat(poolInfo.longUtilizationPercent),
      available_liquidity_usd: parseFloat(poolInfo.longAvailableLiquidity),
    },
    short_side: {
      hourly_borrow_rate_pct: parseFloat(poolInfo.shortBorrowRatePercent),
      utilization_pct: parseFloat(poolInfo.shortUtilizationPercent),
      available_liquidity_usd: parseFloat(poolInfo.shortAvailableLiquidity),
    },
  };
}

/**
 * Get market snapshot for all trading assets
 */
export async function getMarketSnapshot(): Promise<MarketSnapshotOutput> {
  const tradingAssets = getTradingAssets();

  // Fetch data for all assets in parallel
  const marketDataPromises = tradingAssets.map(async (token) => {
    try {
      const { poolInfo, marketStats } = await fetchMarketData(token.symbol as any);
      return transformMarketState(token.symbol, poolInfo, marketStats);
    } catch (error) {
      console.error(`Failed to fetch market data for ${token.symbol}:`, error);
      throw error;
    }
  });

  const markets = await Promise.all(marketDataPromises);

  return {
    timestamp_unix: Math.floor(Date.now() / 1000),
    markets,
  };
}
