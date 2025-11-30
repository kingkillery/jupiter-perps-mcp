/**
 * Technical Indicators Service
 * Provides technical analysis indicators for trading decisions
 *
 * IMPORTANT: This module prioritizes correctness over performance.
 * All indicator calculations include comprehensive validation.
 * Functions will throw errors rather than return potentially incorrect results.
 */

import { getCandles } from "./candles.js";
import { CandleInterval } from "../types.js";
import { RSI, MACD, BollingerBands, ATR, EMA, SMA, Stochastic } from "technicalindicators";

// ==================== Validation Helpers ====================

function validatePeriod(period: any, min: number, max: number, name: string): void {
  if (typeof period !== "number" || !Number.isInteger(period)) {
    throw new Error(`Invalid ${name}: must be an integer (got ${typeof period}: ${period})`);
  }
  if (period < min || period > max) {
    throw new Error(
      `Invalid ${name}: ${period}. Must be between ${min} and ${max}.\n` +
      `Common values: 7 (scalping), 14 (day trading), 21 (swing trading)`
    );
  }
}

function validateStdDev(stdDev: any): void {
  if (typeof stdDev !== "number" || isNaN(stdDev)) {
    throw new Error(`Invalid std_dev: must be a number (got ${typeof stdDev}: ${stdDev})`);
  }
  if (stdDev < 0.5 || stdDev > 4.0) {
    throw new Error(
      `Invalid std_dev: ${stdDev}. Must be between 0.5 and 4.0.\n` +
      `Common values: 1.5 (tight), 2.0 (standard), 2.5 (wide)`
    );
  }
}

function validateMACDParams(fast: any, slow: any, signal: any): void {
  validatePeriod(fast, 2, 50, "macd_fast");
  validatePeriod(slow, 2, 50, "macd_slow");
  validatePeriod(signal, 2, 20, "macd_signal");

  if (fast >= slow) {
    throw new Error(
      `Invalid MACD parameters: fast (${fast}) must be less than slow (${slow}).\n` +
      `Common presets: (12,26,9) standard, (5,13,5) fast, (19,39,9) slow`
    );
  }
}

function validateStochasticParams(kPeriod: any, dPeriod: any): void {
  validatePeriod(kPeriod, 3, 30, "k_period");
  validatePeriod(dPeriod, 2, 10, "d_period");
}

function validateLimit(limit: any): void {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new Error(`Invalid limit: must be an integer (got ${typeof limit}: ${limit})`);
  }
  if (limit < 1 || limit > 500) {
    throw new Error(`Invalid limit: ${limit}. Must be between 1 and 500.`);
  }
}

function validatePriceArray(prices: number[], name: string): void {
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error(`Invalid ${name}: must be a non-empty array`);
  }
  for (let i = 0; i < prices.length; i++) {
    if (typeof prices[i] !== 'number' || isNaN(prices[i]) || prices[i] <= 0) {
      throw new Error(`Invalid ${name} at index ${i}: must be a positive number, got ${prices[i]}`);
    }
  }
}

function validateOHLCData(candles: any[]): void {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(`Invalid candle data: must be a non-empty array`);
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (typeof c.high !== 'number' || isNaN(c.high) || c.high <= 0) {
      throw new Error(`Invalid high price at candle ${i}: must be a positive number, got ${c.high}`);
    }
    if (typeof c.low !== 'number' || isNaN(c.low) || c.low <= 0) {
      throw new Error(`Invalid low price at candle ${i}: must be a positive number, got ${c.low}`);
    }
    if (typeof c.close !== 'number' || isNaN(c.close) || c.close <= 0) {
      throw new Error(`Invalid close price at candle ${i}: must be a positive number, got ${c.close}`);
    }
    if (c.high < c.low) {
      throw new Error(`Invalid OHLC data at candle ${i}: high (${c.high}) must be >= low (${c.low})`);
    }
    if (c.close > c.high || c.close < c.low) {
      throw new Error(`Invalid OHLC data at candle ${i}: close (${c.close}) must be between low (${c.low}) and high (${c.high})`);
    }
  }
}

// ==================== Indicator Functions ====================

/**
 * Calculate RSI (Relative Strength Index)
 * API: RSI.calculate({values, period})
 */
export async function calculateRSI(
  asset: string,
  interval: CandleInterval,
  period: number,
  limit: number
) {
  validatePeriod(period, 2, 50, "rsi_period");
  validateLimit(limit);

  const minCandlesNeeded = period + 1;
  const candlesNeeded = Math.min(limit + period + 50, 500);
  const candlesData = await getCandles(asset, interval, candlesNeeded);

  if (!candlesData.data || candlesData.data.length < minCandlesNeeded) {
    throw new Error(
      `Insufficient data for RSI(${period}). Need at least ${minCandlesNeeded} candles, got ${candlesData.data?.length || 0}.`
    );
  }

  const closePrices = candlesData.data.map(c => c.close);
  validatePriceArray(closePrices, "close prices");

  const rsiValues = RSI.calculate({ values: closePrices, period });

  if (!rsiValues || rsiValues.length === 0) {
    throw new Error(`RSI calculation failed. Check if there's sufficient price variation in the data.`);
  }

  // Validate RSI values are in range [0, 100]
  for (let i = 0; i < rsiValues.length; i++) {
    if (typeof rsiValues[i] !== 'number' || isNaN(rsiValues[i]) || rsiValues[i] < 0 || rsiValues[i] > 100) {
      throw new Error(`Invalid RSI value at index ${i}: ${rsiValues[i]}. RSI must be between 0 and 100.`);
    }
  }

  const startIndex = candlesData.data.length - rsiValues.length;
  const alignedData = rsiValues.map((value, i) => ({
    time: candlesData.data[startIndex + i].time,
    value: value
  }));

  const limitedData = alignedData.slice(-limit);

  if (limitedData.length === 0) {
    throw new Error(`No RSI values after filtering. Increase limit parameter.`);
  }

  const current = limitedData[limitedData.length - 1]?.value;

  return {
    asset: asset.toUpperCase(),
    interval,
    indicator: "rsi",
    parameters: { period },
    data: limitedData,
    current_value: current || null,
    interpretation: {
      overbought_threshold: 70,
      oversold_threshold: 30,
      current_status: current ? (current >= 70 ? "overbought" : current <= 30 ? "oversold" : "neutral") : "unknown"
    }
  };
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * API: MACD.calculate({values, fastPeriod, slowPeriod, signalPeriod, SimpleMAOscillator, SimpleMASignal})
 */
export async function calculateMACD(
  asset: string,
  interval: CandleInterval,
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
  limit: number
) {
  validateMACDParams(fastPeriod, slowPeriod, signalPeriod);
  validateLimit(limit);

  const minCandlesNeeded = slowPeriod + signalPeriod;
  const candlesNeeded = Math.min(limit + minCandlesNeeded + 50, 500);
  const candlesData = await getCandles(asset, interval, candlesNeeded);

  if (!candlesData.data || candlesData.data.length < minCandlesNeeded) {
    throw new Error(
      `Insufficient data for MACD(${fastPeriod},${slowPeriod},${signalPeriod}). Need at least ${minCandlesNeeded} candles, got ${candlesData.data?.length || 0}.`
    );
  }

  const closePrices = candlesData.data.map(c => c.close);
  validatePriceArray(closePrices, "close prices");

  const macdValues = MACD.calculate({
    values: closePrices,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  if (!macdValues || macdValues.length === 0) {
    throw new Error(
      `MACD calculation failed. Need at least ${minCandlesNeeded} candles. ` +
      `Try increasing the limit or using a shorter interval.`
    );
  }

  // Filter to complete values only (MACD library returns incomplete values during warm-up period)
  // This is normal: first slowPeriod values have only MACD, need signalPeriod more for signal/histogram
  const completeValues = macdValues.filter(m =>
    m &&
    typeof m.MACD === 'number' && !isNaN(m.MACD) &&
    typeof m.signal === 'number' && !isNaN(m.signal) &&
    typeof m.histogram === 'number' && !isNaN(m.histogram)
  );

  if (completeValues.length === 0) {
    throw new Error(
      `MACD calculation produced no complete values. ` +
      `Got ${candlesData.data.length} candles, need at least ${minCandlesNeeded + signalPeriod}. ` +
      `Try increasing the limit parameter.`
    );
  }

  const startIndex = candlesData.data.length - completeValues.length;
  const alignedData = completeValues.map((value, i) => ({
    time: candlesData.data[startIndex + i].time,
    macd: value.MACD,
    signal: value.signal,
    histogram: value.histogram
  }));

  const limitedData = alignedData.slice(-limit);

  if (limitedData.length === 0) {
    throw new Error(`No MACD values after filtering.`);
  }

  const current = limitedData[limitedData.length - 1];
  const previous = limitedData.length >= 2 ? limitedData[limitedData.length - 2] : null;

  let crossover = "no_crossover";
  if (previous && current) {
    // Non-null assertion safe here: we filtered for complete values above
    if (previous.histogram! <= 0 && current.histogram! > 0) crossover = "bullish_crossover";
    if (previous.histogram! >= 0 && current.histogram! < 0) crossover = "bearish_crossover";
  }

  return {
    asset: asset.toUpperCase(),
    interval,
    indicator: "macd",
    parameters: { fast: fastPeriod, slow: slowPeriod, signal: signalPeriod },
    data: limitedData,
    current_value: current,
    interpretation: {
      trend: current ? (current.histogram! > 0 ? "bullish" : "bearish") : "unknown",
      crossover
    }
  };
}

/**
 * Calculate Bollinger Bands
 * API: BollingerBands.calculate({period, values, stdDev})
 */
export async function calculateBollingerBands(
  asset: string,
  interval: CandleInterval,
  period: number,
  stdDev: number,
  limit: number
) {
  validatePeriod(period, 5, 50, "bb_period");
  validateStdDev(stdDev);
  validateLimit(limit);

  const minCandlesNeeded = period;
  const candlesNeeded = Math.min(limit + period + 20, 500);
  const candlesData = await getCandles(asset, interval, candlesNeeded);

  if (!candlesData.data || candlesData.data.length < minCandlesNeeded) {
    throw new Error(
      `Insufficient data for Bollinger Bands(${period},${stdDev}). Need at least ${minCandlesNeeded} candles, got ${candlesData.data?.length || 0}.`
    );
  }

  const closePrices = candlesData.data.map(c => c.close);
  validatePriceArray(closePrices, "close prices");

  const bbValues = BollingerBands.calculate({ values: closePrices, period, stdDev });

  if (!bbValues || bbValues.length === 0) {
    throw new Error(`Bollinger Bands calculation failed.`);
  }

  // Validate BB values
  for (let i = 0; i < bbValues.length; i++) {
    const bb = bbValues[i];
    if (!bb || typeof bb.upper !== 'number' || typeof bb.middle !== 'number' || typeof bb.lower !== 'number') {
      throw new Error(`Invalid Bollinger Bands values at index ${i}`);
    }
    if (isNaN(bb.upper) || isNaN(bb.middle) || isNaN(bb.lower)) {
      throw new Error(`Bollinger Bands calculation produced NaN at index ${i}`);
    }
    if (bb.upper < bb.middle || bb.middle < bb.lower) {
      throw new Error(`Invalid BB structure at index ${i}: upper >= middle >= lower required`);
    }
  }

  const startIndex = candlesData.data.length - bbValues.length;
  const alignedData = bbValues.map((value, i) => ({
    time: candlesData.data[startIndex + i].time,
    upper: value.upper,
    middle: value.middle,
    lower: value.lower,
    price: closePrices[startIndex + i]
  }));

  const limitedData = alignedData.slice(-limit);

  if (limitedData.length === 0) {
    throw new Error(`No Bollinger Bands values after filtering.`);
  }

  const current = limitedData[limitedData.length - 1];

  let position = "unknown";
  if (current) {
    if (current.price >= current.upper) position = "above_upper_band";
    else if (current.price <= current.lower) position = "below_lower_band";
    else if (current.price > current.middle) position = "above_middle";
    else position = "below_middle";
  }

  return {
    asset: asset.toUpperCase(),
    interval,
    indicator: "bollinger_bands",
    parameters: { period, std_dev: stdDev },
    data: limitedData,
    current_value: current,
    interpretation: {
      price_position: position,
      bandwidth: current ? ((current.upper - current.lower) / current.middle * 100) : null
    }
  };
}

/**
 * Calculate ATR (Average True Range)
 * API: ATR.calculate({high, low, close, period})
 */
export async function calculateATR(
  asset: string,
  interval: CandleInterval,
  period: number,
  limit: number
) {
  validatePeriod(period, 5, 50, "atr_period");
  validateLimit(limit);

  const minCandlesNeeded = period + 1;
  const candlesNeeded = Math.min(limit + period + 20, 500);
  const candlesData = await getCandles(asset, interval, candlesNeeded);

  if (!candlesData.data || candlesData.data.length < minCandlesNeeded) {
    throw new Error(
      `Insufficient data for ATR(${period}). Need at least ${minCandlesNeeded} candles, got ${candlesData.data?.length || 0}.`
    );
  }

  validateOHLCData(candlesData.data);

  const highs = candlesData.data.map(c => c.high);
  const lows = candlesData.data.map(c => c.low);
  const closes = candlesData.data.map(c => c.close);

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period });

  if (!atrValues || atrValues.length === 0) {
    throw new Error(`ATR calculation failed.`);
  }

  // Validate ATR values (must be positive)
  for (let i = 0; i < atrValues.length; i++) {
    if (typeof atrValues[i] !== 'number' || isNaN(atrValues[i]) || atrValues[i] < 0) {
      throw new Error(`Invalid ATR value at index ${i}: ${atrValues[i]}. ATR must be non-negative.`);
    }
  }

  const startIndex = candlesData.data.length - atrValues.length;
  const alignedData = atrValues.map((value, i) => ({
    time: candlesData.data[startIndex + i].time,
    value: value
  }));

  const limitedData = alignedData.slice(-limit);

  if (limitedData.length === 0) {
    throw new Error(`No ATR values after filtering.`);
  }

  const currentATR = limitedData[limitedData.length - 1]?.value;
  const currentPrice = candlesData.data[candlesData.data.length - 1].close;

  return {
    asset: asset.toUpperCase(),
    interval,
    indicator: "atr",
    parameters: { period },
    data: limitedData,
    current_value: currentATR || null,
    interpretation: {
      atr_percent: currentATR ? (currentATR / currentPrice * 100) : null,
      suggested_stop_loss: {
        "1x_atr": currentATR ? currentPrice - currentATR : null,
        "2x_atr": currentATR ? currentPrice - (2 * currentATR) : null,
        "3x_atr": currentATR ? currentPrice - (3 * currentATR) : null
      }
    }
  };
}

/**
 * Calculate EMA (Exponential Moving Average)
 * API: EMA.calculate({period, values})
 */
export async function calculateEMA(
  asset: string,
  interval: CandleInterval,
  period: number,
  limit: number
) {
  validatePeriod(period, 2, 200, "ema_period");
  validateLimit(limit);

  const minCandlesNeeded = period;
  const candlesNeeded = Math.min(limit + period + 20, 500);
  const candlesData = await getCandles(asset, interval, candlesNeeded);

  if (!candlesData.data || candlesData.data.length < minCandlesNeeded) {
    throw new Error(
      `Insufficient data for EMA(${period}). Need at least ${minCandlesNeeded} candles, got ${candlesData.data?.length || 0}.`
    );
  }

  const closePrices = candlesData.data.map(c => c.close);
  validatePriceArray(closePrices, "close prices");

  const emaValues = EMA.calculate({ values: closePrices, period });

  if (!emaValues || emaValues.length === 0) {
    throw new Error(`EMA calculation failed.`);
  }

  // Validate EMA values
  for (let i = 0; i < emaValues.length; i++) {
    if (typeof emaValues[i] !== 'number' || isNaN(emaValues[i]) || emaValues[i] <= 0) {
      throw new Error(`Invalid EMA value at index ${i}: ${emaValues[i]}`);
    }
  }

  const startIndex = candlesData.data.length - emaValues.length;
  const alignedData = emaValues.map((value, i) => ({
    time: candlesData.data[startIndex + i].time,
    value: value,
    price: closePrices[startIndex + i]
  }));

  const limitedData = alignedData.slice(-limit);

  if (limitedData.length === 0) {
    throw new Error(`No EMA values after filtering.`);
  }

  const current = limitedData[limitedData.length - 1];
  const previous = limitedData.length >= 2 ? limitedData[limitedData.length - 2] : null;

  return {
    asset: asset.toUpperCase(),
    interval,
    indicator: "ema",
    parameters: { period },
    data: limitedData,
    current_value: current?.value || null,
    interpretation: {
      price_vs_ema: current ? (current.price > current.value ? "above" : "below") : "unknown",
      trend: previous && current ? (current.value > previous.value ? "rising" : "falling") : "unknown"
    }
  };
}

/**
 * Calculate SMA (Simple Moving Average)
 * API: SMA.calculate({period, values})
 */
export async function calculateSMA(
  asset: string,
  interval: CandleInterval,
  period: number,
  limit: number
) {
  validatePeriod(period, 5, 200, "sma_period");
  validateLimit(limit);

  const minCandlesNeeded = period;
  const candlesNeeded = Math.min(limit + period + 20, 500);
  const candlesData = await getCandles(asset, interval, candlesNeeded);

  if (!candlesData.data || candlesData.data.length < minCandlesNeeded) {
    throw new Error(
      `Insufficient data for SMA(${period}). Need at least ${minCandlesNeeded} candles, got ${candlesData.data?.length || 0}.`
    );
  }

  const closePrices = candlesData.data.map(c => c.close);
  validatePriceArray(closePrices, "close prices");

  const smaValues = SMA.calculate({ values: closePrices, period });

  if (!smaValues || smaValues.length === 0) {
    throw new Error(`SMA calculation failed.`);
  }

  // Validate SMA values
  for (let i = 0; i < smaValues.length; i++) {
    if (typeof smaValues[i] !== 'number' || isNaN(smaValues[i]) || smaValues[i] <= 0) {
      throw new Error(`Invalid SMA value at index ${i}: ${smaValues[i]}`);
    }
  }

  const startIndex = candlesData.data.length - smaValues.length;
  const alignedData = smaValues.map((value, i) => ({
    time: candlesData.data[startIndex + i].time,
    value: value,
    price: closePrices[startIndex + i]
  }));

  const limitedData = alignedData.slice(-limit);

  if (limitedData.length === 0) {
    throw new Error(`No SMA values after filtering.`);
  }

  const current = limitedData[limitedData.length - 1];
  const previous = limitedData.length >= 2 ? limitedData[limitedData.length - 2] : null;

  return {
    asset: asset.toUpperCase(),
    interval,
    indicator: "sma",
    parameters: { period },
    data: limitedData,
    current_value: current?.value || null,
    interpretation: {
      price_vs_sma: current ? (current.price > current.value ? "above" : "below") : "unknown",
      trend: previous && current ? (current.value > previous.value ? "rising" : "falling") : "unknown"
    }
  };
}

/**
 * Calculate Stochastic Oscillator
 * API: Stochastic.calculate({high, low, close, period, signalPeriod})
 */
export async function calculateStochastic(
  asset: string,
  interval: CandleInterval,
  kPeriod: number,
  dPeriod: number,
  limit: number
) {
  validateStochasticParams(kPeriod, dPeriod);
  validateLimit(limit);

  const minCandlesNeeded = kPeriod + dPeriod;
  const candlesNeeded = Math.min(limit + minCandlesNeeded + 20, 500);
  const candlesData = await getCandles(asset, interval, candlesNeeded);

  if (!candlesData.data || candlesData.data.length < minCandlesNeeded) {
    throw new Error(
      `Insufficient data for Stochastic(${kPeriod},${dPeriod}). Need at least ${minCandlesNeeded} candles, got ${candlesData.data?.length || 0}.`
    );
  }

  validateOHLCData(candlesData.data);

  const highs = candlesData.data.map(c => c.high);
  const lows = candlesData.data.map(c => c.low);
  const closes = candlesData.data.map(c => c.close);

  const stochValues = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: kPeriod,
    signalPeriod: dPeriod
  });

  if (!stochValues || stochValues.length === 0) {
    throw new Error(
      `Stochastic calculation failed. Need at least ${minCandlesNeeded} candles. ` +
      `Try increasing the limit or using a shorter interval.`
    );
  }

  // Filter to complete values only (Stochastic library returns incomplete values during warm-up period)
  // This is normal: first kPeriod values have only %K, need dPeriod more for %D
  const completeValues = stochValues.filter(s =>
    s &&
    typeof s.k === 'number' && !isNaN(s.k) && s.k >= 0 && s.k <= 100 &&
    typeof s.d === 'number' && !isNaN(s.d) && s.d >= 0 && s.d <= 100
  );

  if (completeValues.length === 0) {
    throw new Error(
      `Stochastic calculation produced no complete values. ` +
      `Got ${candlesData.data.length} candles, need at least ${minCandlesNeeded + dPeriod}. ` +
      `Try increasing the limit parameter.`
    );
  }

  const startIndex = candlesData.data.length - completeValues.length;
  const alignedData = completeValues.map((value, i) => ({
    time: candlesData.data[startIndex + i].time,
    k: value.k,
    d: value.d
  }));

  const limitedData = alignedData.slice(-limit);

  if (limitedData.length === 0) {
    throw new Error(`No Stochastic values after filtering.`);
  }

  const current = limitedData[limitedData.length - 1];
  const previous = limitedData.length >= 2 ? limitedData[limitedData.length - 2] : null;

  let crossover = "no_crossover";
  if (previous && current) {
    if (previous.k <= previous.d && current.k > current.d) crossover = "bullish_crossover";
    if (previous.k >= previous.d && current.k < current.d) crossover = "bearish_crossover";
  }

  const status = current ? (current.k >= 80 ? "overbought" : current.k <= 20 ? "oversold" : "neutral") : "unknown";

  return {
    asset: asset.toUpperCase(),
    interval,
    indicator: "stochastic",
    parameters: { k_period: kPeriod, d_period: dPeriod },
    data: limitedData,
    current_value: current || null,
    interpretation: {
      status,
      crossover
    }
  };
}
