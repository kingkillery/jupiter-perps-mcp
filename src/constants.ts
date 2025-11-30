/**
 * Constants for Jupiter Perps trading
 * Contains token information, oracles, and API endpoints
 */

import { PublicKey } from "@solana/web3.js";

export interface TokenInfo {
  symbol: string;
  mint: PublicKey;
  custodyAccount: PublicKey;
}

/**
 * Supported trading assets on Jupiter Perps
 * These are the assets available in the JLP Pool
 */
export const TOKENS = {
  SOL: {
    symbol: "SOL" as const,
    mint: new PublicKey("So11111111111111111111111111111111111111112"),
    custodyAccount: new PublicKey("7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz"),
  },
  ETH: {
    symbol: "ETH" as const,
    mint: new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
    custodyAccount: new PublicKey("AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn"),
  },
  BTC: {
    symbol: "BTC" as const,
    mint: new PublicKey("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"),
    custodyAccount: new PublicKey("5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm"),
  },
  USDC: {
    symbol: "USDC" as const,
    mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    custodyAccount: new PublicKey("G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa"),
  },
  USDT: {
    symbol: "USDT" as const,
    mint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    custodyAccount: new PublicKey("4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk"),
  },
} as const;

/**
 * Type for token symbols
 */
export type TokenSymbol = keyof typeof TOKENS;

/**
 * List of all supported token symbols
 */
export const SUPPORTED_ASSETS: TokenSymbol[] = Object.keys(TOKENS) as TokenSymbol[];

/**
 * Jupiter Perps API endpoints
 */
export const JUPITER_API = {
  BASE_URL: "https://perps-api.jup.ag/v1",
  ENDPOINTS: {
    POOL_INFO: "/pool-info",
    MARKET_STATS: "/market-stats",
    POSITIONS: "/positions",
    INCREASE_POSITION: "/positions/increase",
    DECREASE_POSITION: "/positions-gasless/decrease",
  },
};

/**
 * Jupiter Ultra API for wallet holdings
 */
export const ULTRA_API = {
  BASE_URL: "https://ultra-api.jup.ag",
  ENDPOINTS: {
    HOLDINGS: "/holdings",
  },
};

/**
 * USDC mint address (for extracting USDC balance from holdings)
 */
export const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Oracle Security History API for candle data
 */
export const CANDLES_API = {
  BASE_URL: "https://history.oraclesecurity.org/trading-view/data",
};

/**
 * Interval mapping for candle data API
 * Maps our interval format to the API's expected format
 */
export const INTERVAL_MAPPING: Record<string, string> = {
  "5m": "5",
  "15m": "15",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
  "1w": "1W",
};

/**
 * Asset feed mapping for candle data API
 * Maps asset symbols to their oracle feed names
 */
export const ASSET_FEED_MAPPING: Record<string, string> = {
  SOL: "SOLUSD",
  ETH: "ETHUSD",
  BTC: "BTCUSD",
};

/**
 * Helper function to get token info by symbol
 */
export function getTokenInfo(symbol: string): TokenInfo {
  const upperSymbol = symbol.toUpperCase() as TokenSymbol;
  const token = TOKENS[upperSymbol];
  if (!token) {
    throw new Error(`Unsupported token: ${symbol}. Supported: ${SUPPORTED_ASSETS.join(", ")}`);
  }
  return token;
}

/**
 * Helper function to get all trading assets (exclude stablecoins)
 */
export function getTradingAssets(): TokenInfo[] {
  return Object.values(TOKENS).filter(
    (token) => !["USDC", "USDT"].includes(token.symbol)
  );
}

/**
 * Helper function to get token by mint address
 */
export function getTokenByMint(mintAddress: string): TokenInfo | undefined {
  return Object.values(TOKENS).find(
    (token) => token.mint.toBase58() === mintAddress
  );
}
