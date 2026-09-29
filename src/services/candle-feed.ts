import type { Candle, CandleInterval } from "../types.js";

const BASE = "https://api.kraken.com/0/public/OHLC";
const PAIRS: Record<string, string> = { SOL: "SOLUSD", ETH: "ETHUSD", BTC: "XBTUSD" };
const MINUTES: Record<CandleInterval, number> = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
export const CANDLE_SOURCE = "Kraken spot USD";

export type CandleSnapshot = { result: Candle[]; current_price: number; source: string; sampled_at: number };

function numeric(value: unknown, label: string, allowZero = false): number {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new Error("Invalid Kraken " + label);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error("Invalid Kraken " + label);
  }
  return parsed;
}

function timestamp(value: unknown, label: string): number {
  const seconds = numeric(value, label);
  if (!Number.isSafeInteger(seconds)) throw new Error("Invalid Kraken " + label);
  return seconds * 1000;
}

// Kraken documents that its final OHLC row is the current, unfinished candle.
export async function fetchKrakenCandles(
  asset: string, interval: CandleInterval, limit: number, signal?: AbortSignal
): Promise<CandleSnapshot> {
  const pair = PAIRS[asset.toUpperCase()];
  const minutes = MINUTES[interval];
  if (!pair || !minutes || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Unsupported candle request");
  }
  const url = new URL(BASE);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", String(minutes));
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error("Kraken candles returned HTTP " + response.status);
  const data = await response.json();
  if (!data || !Array.isArray(data.error) || data.error.length || !data.result || typeof data.result !== "object") {
    throw new Error("Kraken candles returned an error or invalid response");
  }
  const keys = Object.keys(data.result).filter(key => key !== "last");
  if (keys.length !== 1 || !Array.isArray(data.result[keys[0]])) {
    throw new Error("Kraken candle pair missing or ambiguous");
  }
  const rows: unknown[] = data.result[keys[0]];
  if (rows.length < limit + 1) throw new Error("Too few completed Kraken candles");
  const captured = Date.now();
  const intervalMs = minutes * 60_000;
  const current = rows.at(-1);
  if (!Array.isArray(current) || current.length < 8) throw new Error("Invalid current Kraken candle");
  const currentTime = timestamp(current[0], "current candle time");
  const currentOpen = numeric(current[1], "current open");
  const currentHigh = numeric(current[2], "current high");
  const currentLow = numeric(current[3], "current low");
  const currentPrice = numeric(current[4], "current price");
  if (currentHigh < Math.max(currentOpen, currentPrice) || currentLow > Math.min(currentOpen, currentPrice) || currentLow > currentHigh) {
    throw new Error("Invalid current Kraken candle prices");
  }
  if (currentTime > captured || captured - currentTime >= intervalMs + 120_000) {
    throw new Error("Kraken's current candle is stale or ahead of the local clock");
  }
  const completeRows = rows.slice(-limit - 1, -1);
  let previousTime: number | undefined;
  const completed = completeRows.map((row): Candle => {
    if (!Array.isArray(row) || row.length < 8) throw new Error("Invalid Kraken candle row");
    const time = timestamp(row[0], "candle time");
    const open = numeric(row[1], "open");
    const high = numeric(row[2], "high");
    const low = numeric(row[3], "low");
    const close = numeric(row[4], "close");
    const volume = numeric(row[6], "volume", true);
    const trades = numeric(row[7], "trade count", true);
    if (!Number.isSafeInteger(trades) || high < Math.max(open, close) || low > Math.min(open, close) || low > high || (trades === 0 && volume > 0)) {
      throw new Error("Invalid completed Kraken candle");
    }
    if (previousTime !== undefined && time !== previousTime + intervalMs) {
      throw new Error("Kraken candles have a gap or duplicate");
    }
    previousTime = time;
    return { time, open, high, low, close, volume };
  });
  if (completed.at(-1)!.time + intervalMs !== currentTime) {
    throw new Error("Latest completed Kraken candle is stale");
  }
  return { result: completed, current_price: currentPrice, source: CANDLE_SOURCE, sampled_at: captured };
}