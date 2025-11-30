/**
 * Candles data service
 * Handles fetching and transforming historical price data
 */

import { fetchCandles } from "../api.js";
import { CandlesOutput, CandleInterval } from "../types.js";

/**
 * Cache entry structure
 */
interface CacheEntry {
  data: CandlesOutput;
  timestamp: number;
}

/**
 * In-memory cache for candle data
 * Key format: `${asset}_${interval}_${limit}`
 */
const candlesCache = new Map<string, CacheEntry>();

/**
 * Cache TTL: 1 minute for all intervals
 * Conservative approach prioritizing data correctness over performance
 */
const CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * Generate cache key from parameters
 */
function getCacheKey(asset: string, interval: CandleInterval, limit: number): string {
  return `${asset.toUpperCase()}_${interval}_${limit}`;
}

/**
 * Minimum candle limit for all intervals
 * Set conservatively to avoid time-dependent API failures with short intervals
 * The 5m interval can require 4-5 candles depending on timing
 */
const MIN_CANDLE_LIMIT = 10;

/**
 * Get historical candle data for an asset
 * Results are cached for 1 minute to optimize multiple indicator calls
 * @param asset - Asset symbol (SOL, ETH, BTC)
 * @param interval - Candle interval (5m, 15m, 1h, 4h, 1d, 1w)
 * @param limit - Number of candles to retrieve (minimum 10, maximum 500)
 */
export async function getCandles(
  asset: string,
  interval: CandleInterval,
  limit: number
): Promise<CandlesOutput> {
  // Validate limit range
  if (limit < MIN_CANDLE_LIMIT || limit > 500) {
    throw new Error(
      `Limit must be between ${MIN_CANDLE_LIMIT} and 500 (got ${limit}). ` +
      `Minimum of ${MIN_CANDLE_LIMIT} candles required to ensure API compatibility.`
    );
  }

  // Check cache
  const cacheKey = getCacheKey(asset, interval, limit);
  const cached = candlesCache.get(cacheKey);

  if (cached) {
    const age = Date.now() - cached.timestamp;
    if (age < CACHE_TTL_MS) {
      // Cache hit - return cached data
      return cached.data;
    } else {
      // Cache expired - remove from cache
      candlesCache.delete(cacheKey);
    }
  }

  // Cache miss or expired - fetch from API
  const response = await fetchCandles(asset, interval, limit);

  // Transform API response to output format
  // Convert timestamps from milliseconds to seconds
  const data = response.result.map((candle) => ({
    time: Math.floor(candle.time / 1000), // Convert ms to seconds
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));

  const result: CandlesOutput = {
    asset: asset.toUpperCase(),
    interval,
    data,
  };

  // Store in cache
  candlesCache.set(cacheKey, {
    data: result,
    timestamp: Date.now(),
  });

  return result;
}
