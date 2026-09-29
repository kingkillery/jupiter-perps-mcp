import { KRONOS_EVALUATION_TOOL } from "./services/kronos-evaluation.js";
import { KronosService, KRONOS_TOOL } from "./services/kronos.js";
import { EntryControls, ENTRY_TOOLS } from "./services/entry-controls.js";
import { PROTECTION_TOOLS, runProtectionTool } from "./services/protection.js";
import { BrowserWalletBridge } from "./wallet/browser-bridge.js";
import { keypairSigner } from "./utils/transactions.js";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { Connection, Keypair } from "@solana/web3.js";
import express from "express";
import { getMarketSnapshot } from "./services/market.js";
import { getCandles } from "./services/candles.js";
import { getAccountPortfolio } from "./services/portfolio.js";
import { estimateOpenPosition } from "./services/estimate.js";
import { openPosition } from "./services/open-position.js";
import { closePosition } from "./services/close-position.js";
import {
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateEMA,
  calculateSMA,
  calculateStochastic,
} from "./services/indicators.js";
import bs58 from "bs58";

// Load environment variables
dotenv.config();

// Global configuration
const WALLET_MODE = process.env.WALLET_MODE || "keypair";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const browserWallet = new BrowserWalletBridge();
const kronos = new KronosService();
const strategy = JSON.parse(readFileSync(new URL("../strategy.json", import.meta.url), "utf8"));
const tradingBlocker = "Direct entry is disabled. Use preview_strategy_entry and the local wallet risk controls; only validated entries with atomic protection may request approval.";
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const MAX_SLIPPAGE_BPS = parseInt(process.env.MAX_SLIPPAGE_BPS || "200");

// Priority fee: 100k microLamports is a balanced default (~0.00002 SOL for typical tx)
// Advanced users can override with PRIORITY_FEE_MICRO_LAMPORTS env var if needed
const PRIORITY_FEE_MICRO_LAMPORTS = parseInt(
  process.env.PRIORITY_FEE_MICRO_LAMPORTS || "100000"
);

// MCP Server mode: stdio (default) or http (remote)
const MCP_MODE = process.env.MCP_MODE || (process.argv.includes("--remote") ? "http" : "stdio");
const MCP_PORT = parseInt(process.env.MCP_PORT || "3000");

// Common property definitions for tool schemas
const ASSET_PROPERTY = {
  type: "string" as const,
  enum: ["SOL", "ETH", "BTC"],
  description: "The asset symbol",
};

const ASSET_PROPERTY_TRADING = {
  type: "string" as const,
  enum: ["SOL", "BTC", "ETH"],
  description: "The asset to trade",
};

const INTERVAL_PROPERTY = {
  type: "string" as const,
  enum: ["5m", "15m", "1h", "4h", "1d", "1w"],
  description: "Candle interval/timeframe",
};

const SIDE_PROPERTY = {
  type: "string" as const,
  enum: ["Long", "Short"],
  description: "Direction of the trade",
};

const LIMIT_PROPERTY = {
  type: "integer" as const,
  minimum: 10,
  maximum: 500,
  description: "Number of data points to return (10-500). Use 10-20 for quick checks, 50-100 for recent trend, 200+ for historical analysis.",
};

const COLLATERAL_AMOUNT_PROPERTY = {
  type: "number" as const,
  description: "Amount of USDC to use as collateral (minimum: 10 USD, must be <= wallet balance)",
};

const LEVERAGE_PROPERTY = {
  type: "number" as const,
  minimum: 1.1,
  maximum: 7,
  description: "Leverage multiplier (added size = collateral * leverage)",
};

// Validation constants
const VALID_ASSETS = ["SOL", "ETH", "BTC"];
const VALID_INTERVALS = ["5m", "15m", "1h", "4h", "1d", "1w"];
const VALID_SIDES = ["Long", "Short"];
const MIN_COLLATERAL_USDC = 10;
const MAX_COLLATERAL_USDC = 1_000_000;

// Initialize Solana connection with "confirmed" commitment level
const connection = new Connection(RPC_URL, "confirmed");
const entries = new EntryControls({connection,strategy,slippageBps:MAX_SLIPPAGE_BPS,priorityFee:PRIORITY_FEE_MICRO_LAMPORTS,address:currentWalletAddress,cancelApproval:()=>browserWallet.cancelApproval(),signer:(summary,signal)=>browserWallet.signer(summary,signal)});

// Initialize wallet from private key
let walletKeypair: Keypair | null = null;
let walletAddress: string | null = null;

if (WALLET_MODE === "keypair" && WALLET_PRIVATE_KEY) {
  try {
    // Decode base58 private key
    const secretKey = bs58.decode(WALLET_PRIVATE_KEY);
    walletKeypair = Keypair.fromSecretKey(secretKey);
    walletAddress = walletKeypair.publicKey.toBase58();
  } catch (error) {
    console.error("Failed to load wallet from WALLET_PRIVATE_KEY:", error);
  }
}

// Tool definitions
const TOOLS: Tool[] = [
  KRONOS_TOOL,
  KRONOS_EVALUATION_TOOL,
  ...PROTECTION_TOOLS,
  ...ENTRY_TOOLS,
  { name: "get_strategy_plan", description: "Read the configured SOL intraday plan, risk cap, target split, and live-execution blockers. Does not place orders.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_market_snapshot",
    description:
      "Retrieves current market state for all trading assets (SOL, ETH, BTC). Returns timestamp and market data including: index prices, 24h statistics (change %, high, low, volume), trading fees (base fee %, max price impact %), and for both long/short sides: hourly borrow rates, utilization %, and available liquidity in USD. Note: Short positions use a shared USDC liquidity pool, so short_side metrics (utilization, borrow rate) are identical across all assets. Long positions borrow asset-specific tokens, so long_side metrics vary by asset.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_candles",
    description:
      "Retrieves historical OHLCV (Open, High, Low, Close, Volume) pricing data for trend analysis and technical analysis. Returns candle data with timestamps (unix seconds), open/high/low/close prices, and volume. Minimum 3 candles required.",
    inputSchema: {
      type: "object",
      properties: {
        asset: { ...ASSET_PROPERTY, description: "The asset symbol to retrieve candles for" },
        interval: INTERVAL_PROPERTY,
        limit: { ...LIMIT_PROPERTY, description: "Number of candles to retrieve (minimum 3, maximum 500). Use 50-100 for recent analysis, 200+ for historical patterns." },
      },
      required: ["asset", "interval", "limit"],
    },
  },
  {
    name: "get_account_portfolio",
    description:
      "Retrieves wallet's current USDC balance, total equity, and all open positions. For each position returns: asset, side (Long/Short), collateral, equity, size, entry price, mark price, leverage, liquidation price, and fees_to_close (accrued borrow fees that will be settled, estimated close fee, estimated price impact).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "estimate_open_position",
    description:
      "Estimates fees and resulting position state for opening a new position or increasing an existing one. Returns: (1) fees_to_pay - fees for THIS trade only: open fee, price impact fee, and any accrued borrow fees that will be settled; (2) resulting_position - final state AFTER trade: weighted average entry price, total size, total collateral, leverage, and liquidation price. Does NOT execute the trade. Important: total_collateral_usd includes protocol-specific factors beyond visible fees: (a) USDC price typically ~$0.9997-1.0003, not exactly $1.00; (b) Long positions incur additional swap costs (~0.05%) when converting USDC to the borrowed asset; (c) rounding/slippage. Short positions generally match calculations more closely as they borrow USDC directly. Note: The Jupiter protocol returns slightly lower leverage than requested, with larger differences at higher leverage (e.g., 10x → 9.99x, 100x → 99.47x).",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY_TRADING,
        side: SIDE_PROPERTY,
        collateral_amount: COLLATERAL_AMOUNT_PROPERTY,
        leverage: LEVERAGE_PROPERTY,
      },
      required: ["asset", "side", "collateral_amount", "leverage"],
    },
  },
  {
    name: "open_position",
    description:
      "Submits a transaction to open a new position or increase an existing one. The protocol processes asynchronously (may take a few seconds) - use get_account_portfolio to verify. Returns transaction signature (for logging) and confirmation message.",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY_TRADING,
        side: SIDE_PROPERTY,
        collateral_amount: COLLATERAL_AMOUNT_PROPERTY,
        leverage: LEVERAGE_PROPERTY,
      },
      required: ["asset", "side", "collateral_amount", "leverage"],
    },
  },
  {
    name: "close_position",
    description:
      "Submits a transaction to fully close an existing position at market price. The protocol processes asynchronously (may take a few seconds) - use get_account_portfolio to verify closure. Returns transaction signature (for logging) and confirmation message. Collateral is returned as USDC.",
    inputSchema: {
      type: "object",
      properties: {
        asset: { ...ASSET_PROPERTY_TRADING, description: "The asset of the position to close" },
        side: { ...SIDE_PROPERTY, description: "The side of the position to close" },
      },
      required: ["asset", "side"],
    },
  },
  {
    name: "get_indicator_rsi",
    description:
      "Calculate RSI (Relative Strength Index) - a momentum oscillator that measures overbought/oversold conditions. RSI ranges from 0-100. Values above 70 indicate overbought, below 30 indicate oversold. Common period values: 7 (scalping), 14 (day trading), 21 (swing trading).",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY,
        interval: INTERVAL_PROPERTY,
        period: {
          type: "integer",
          minimum: 2,
          maximum: 50,
          description: "RSI period (2-50). Common: 7 (scalping), 14 (standard), 21 (swing)",
        },
        limit: LIMIT_PROPERTY,
      },
      required: ["asset", "interval", "period", "limit"],
    },
  },
  {
    name: "get_indicator_macd",
    description:
      "Calculate MACD (Moving Average Convergence Divergence) - identifies trend direction and momentum. Returns MACD line, signal line, and histogram. Histogram crossing zero indicates trend changes. Common settings: (12,26,9) standard, (5,13,5) fast/scalping, (19,39,9) slow/swing.",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY,
        interval: INTERVAL_PROPERTY,
        fast_period: {
          type: "integer",
          minimum: 2,
          maximum: 50,
          description: "Fast EMA period (2-50). Must be less than slow_period.",
        },
        slow_period: {
          type: "integer",
          minimum: 2,
          maximum: 50,
          description: "Slow EMA period (2-50). Must be greater than fast_period.",
        },
        signal_period: {
          type: "integer",
          minimum: 2,
          maximum: 20,
          description: "Signal line period (2-20). Common: 9",
        },
        limit: LIMIT_PROPERTY,
      },
      required: ["asset", "interval", "fast_period", "slow_period", "signal_period", "limit"],
    },
  },
  {
    name: "get_indicator_bollinger_bands",
    description:
      "Calculate Bollinger Bands - measures volatility and identifies overbought/oversold conditions. Returns upper band, middle (SMA), and lower band. Price touching upper band suggests overbought, lower band suggests oversold. Common settings: (20,2) standard, (20,1.5) tight, (20,2.5) wide.",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY,
        interval: INTERVAL_PROPERTY,
        period: {
          type: "integer",
          minimum: 5,
          maximum: 50,
          description: "Period for middle band SMA (5-50). Common: 20",
        },
        std_dev: {
          type: "number",
          minimum: 0.5,
          maximum: 4.0,
          description: "Standard deviation multiplier (0.5-4.0). Common: 1.5 (tight), 2.0 (standard), 2.5 (wide)",
        },
        limit: LIMIT_PROPERTY,
      },
      required: ["asset", "interval", "period", "std_dev", "limit"],
    },
  },
  {
    name: "get_indicator_atr",
    description:
      "Calculate ATR (Average True Range) - measures volatility for stop-loss placement and position sizing. Higher ATR = higher volatility. Returns suggested stop-loss levels at 1x, 2x, 3x ATR below current price. Common periods: 10, 14, 20.",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY,
        interval: INTERVAL_PROPERTY,
        period: {
          type: "integer",
          minimum: 5,
          maximum: 50,
          description: "ATR period (5-50). Common: 10, 14, 20",
        },
        limit: LIMIT_PROPERTY,
      },
      required: ["asset", "interval", "period", "limit"],
    },
  },
  {
    name: "get_indicator_ema",
    description:
      "Calculate EMA (Exponential Moving Average) - a trend indicator that reacts faster to price changes than SMA. Price above EMA suggests uptrend, below suggests downtrend. Common periods: 9, 20, 50, 100, 200.",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY,
        interval: INTERVAL_PROPERTY,
        period: {
          type: "integer",
          minimum: 2,
          maximum: 200,
          description: "EMA period (2-200). Common: 9, 20, 50, 100, 200",
        },
        limit: LIMIT_PROPERTY,
      },
      required: ["asset", "interval", "period", "limit"],
    },
  },
  {
    name: "get_indicator_sma",
    description:
      "Calculate SMA (Simple Moving Average) - a classic trend indicator. Price above SMA suggests uptrend, below suggests downtrend. Slower to react than EMA. Common periods: 20, 50, 100, 200.",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY,
        interval: INTERVAL_PROPERTY,
        period: {
          type: "integer",
          minimum: 5,
          maximum: 200,
          description: "SMA period (5-200). Common: 20, 50, 100, 200",
        },
        limit: LIMIT_PROPERTY,
      },
      required: ["asset", "interval", "period", "limit"],
    },
  },
  {
    name: "get_indicator_stochastic",
    description:
      "Calculate Stochastic Oscillator - a momentum indicator comparing closing price to price range. Returns %K and %D lines. Values above 80 indicate overbought, below 20 indicate oversold. %K crossing above %D is bullish signal. Common settings: (14,3) standard, (5,3) fast, (21,7) slow.",
    inputSchema: {
      type: "object",
      properties: {
        asset: ASSET_PROPERTY,
        interval: INTERVAL_PROPERTY,
        k_period: {
          type: "integer",
          minimum: 3,
          maximum: 30,
          description: "%K period (3-30). Common: 5 (fast), 14 (standard), 21 (slow)",
        },
        d_period: {
          type: "integer",
          minimum: 2,
          maximum: 10,
          description: "%D period (2-10). Common: 3",
        },
        limit: LIMIT_PROPERTY,
      },
      required: ["asset", "interval", "k_period", "d_period", "limit"],
    },
  },
];

// Input validation helpers
function validateAsset(asset: any): void {
  if (!asset || typeof asset !== "string") {
    throw new Error(`Invalid asset: must be a string`);
  }
  if (!VALID_ASSETS.includes(asset.toUpperCase())) {
    throw new Error(`Invalid asset: ${asset}. Must be one of: ${VALID_ASSETS.join(", ")}`);
  }
}

function validateSide(side: any): void {
  if (!side || typeof side !== "string") {
    throw new Error(`Invalid side: must be a string`);
  }
  if (!VALID_SIDES.includes(side)) {
    throw new Error(`Invalid side: ${side}. Must be one of: ${VALID_SIDES.join(", ")}`);
  }
}

function validateInterval(interval: any): void {
  if (!interval || typeof interval !== "string") {
    throw new Error(`Invalid interval: must be a string`);
  }
  if (!VALID_INTERVALS.includes(interval)) {
    throw new Error(`Invalid interval: ${interval}. Must be one of: ${VALID_INTERVALS.join(", ")}`);
  }
}

function validatePositiveNumber(value: any, fieldName: string, min?: number, max?: number): void {
  if (typeof value !== "number" || isNaN(value)) {
    throw new Error(`Invalid ${fieldName}: must be a number`);
  }
  if (value <= 0) {
    throw new Error(`Invalid ${fieldName}: must be positive (got ${value})`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`Invalid ${fieldName}: must be >= ${min} (got ${value})`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`Invalid ${fieldName}: must be <= ${max} (got ${value})`);
  }
}

function validateCollateralAmount(collateral_amount: number): void {
  if (collateral_amount < MIN_COLLATERAL_USDC) {
    throw new Error(`Invalid collateral_amount: ${collateral_amount} USDC is below minimum of ${MIN_COLLATERAL_USDC} USDC`);
  }
  if (collateral_amount > MAX_COLLATERAL_USDC) {
    throw new Error(`Invalid collateral_amount: ${collateral_amount} exceeds maximum of ${MAX_COLLATERAL_USDC.toLocaleString()} USDC`);
  }
}

// Tool handler functions
async function handleGetMarketSnapshot(args: any): Promise<any> {
  // No input validation needed - no parameters
  return await getMarketSnapshot();
}

async function handleGetCandles(args: any): Promise<any> {
  const { asset, interval, limit } = args;

  // Validate inputs
  validateAsset(asset);
  validateInterval(interval);
  validatePositiveNumber(limit, "limit", 10, 500);
  if (!Number.isInteger(limit)) {
    throw new Error(`Invalid limit: must be an integer (got ${limit})`);
  }

  return await getCandles(asset, interval, limit);
}

function currentWalletAddress(): string | null {
  return WALLET_MODE === "browser" ? browserWallet.address : walletAddress;
}

async function handleGetAccountPortfolio(args: any): Promise<any> {
  const walletAddress = currentWalletAddress();
  if (!walletAddress) {
    throw new Error("Wallet not initialized. Please check WALLET_PRIVATE_KEY in .env file");
  }
  // No input validation needed - no parameters
  return await getAccountPortfolio(walletAddress);
}

async function handleEstimateOpenPosition(args: any): Promise<any> {
  const walletAddress = currentWalletAddress();
  if (!walletAddress) {
    throw new Error("Wallet not initialized. Please check WALLET_PRIVATE_KEY in .env file");
  }

  const { asset, side, collateral_amount, leverage } = args;

  // Validate inputs
  validateAsset(asset);
  validateSide(side);
  validatePositiveNumber(collateral_amount, "collateral_amount");
  validateCollateralAmount(collateral_amount);
  validatePositiveNumber(leverage, "leverage", 1.1, 7);

  return await estimateOpenPosition(
    walletAddress,
    asset,
    side,
    collateral_amount,
    leverage,
    MAX_SLIPPAGE_BPS
  );
}

async function handleOpenPosition(_args: any, _signal?: AbortSignal): Promise<any> {
  throw new Error(tradingBlocker);
}
async function handleClosePosition(_args: any, _signal?: AbortSignal): Promise<any> {
  throw new Error("Use close_position_partial with an explicit size; the legacy full-close builder is disabled.");
}

// Each stateless HTTP request owns its protocol instance.
function createServer(): Server {
  // Main server setup
  const server = new Server(
    {
      name: "jupiter-perps-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "evaluate_kronos") {
        const result = await kronos.evaluate(args, extra.signal);
        return {content:[{type:"text",text:JSON.stringify(result)}]};
      }
      if (name === "get_kronos_forecast") {
        const result = await kronos.forecast(args, extra.signal);
        return {content:[{type:"text",text:JSON.stringify(result,null,2)}]};
      }
      if (name === "preview_strategy_entry") {
        const result = await entries.preview(args, extra.signal);
        return {content:[{type:"text",text:JSON.stringify(result,null,2)}]};
      }
      if (PROTECTION_TOOLS.some(tool => tool.name === name)) {
        const address = currentWalletAddress();
        if (!address) throw new Error("Connect Jupiter Wallet on the local wallet page first");
        const result = await runProtectionTool(name, args, {
          address, connection, slippageBps: MAX_SLIPPAGE_BPS, priorityFee: PRIORITY_FEE_MICRO_LAMPORTS, signal: extra.signal,
          browserMode: WALLET_MODE === "browser",
          signer: summary => browserWallet.signer(summary, extra.signal),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const a = args as any; // Simplify repetitive type casting
      let result;
      switch (name) {
        case "get_strategy_plan":
          result = { ...strategy, wallet_connected: !!currentWalletAddress(), live_execution_enabled: false };
          break;
        case "get_market_snapshot":
          result = await handleGetMarketSnapshot(args);
          break;
        case "get_candles":
          result = await handleGetCandles(args);
          break;
        case "get_account_portfolio":
          result = await handleGetAccountPortfolio(args);
          break;
        case "estimate_open_position":
          result = await handleEstimateOpenPosition(args);
          break;
        case "open_position":
          result = await handleOpenPosition(args, extra.signal);
          break;
        case "close_position":
          result = await handleClosePosition(args, extra.signal);
          break;
        case "get_indicator_rsi":
          result = await calculateRSI(a.asset, a.interval, a.period, a.limit);
          break;
        case "get_indicator_macd":
          result = await calculateMACD(a.asset, a.interval, a.fast_period, a.slow_period, a.signal_period, a.limit);
          break;
        case "get_indicator_bollinger_bands":
          result = await calculateBollingerBands(a.asset, a.interval, a.period, a.std_dev, a.limit);
          break;
        case "get_indicator_atr":
          result = await calculateATR(a.asset, a.interval, a.period, a.limit);
          break;
        case "get_indicator_ema":
          result = await calculateEMA(a.asset, a.interval, a.period, a.limit);
          break;
        case "get_indicator_sma":
          result = await calculateSMA(a.asset, a.interval, a.period, a.limit);
          break;
        case "get_indicator_stochastic":
          result = await calculateStochastic(a.asset, a.interval, a.k_period, a.d_period, a.limit);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });
  return server;
}

// Start the server in stdio mode
async function startStdioServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jupiter Perps MCP Server running on stdio");
}

// Start the server in HTTP mode
async function startHttpServer() {
  const app = express();

  // Middleware
  app.disable("x-powered-by");
  const allowedHosts = new Set([`127.0.0.1:${MCP_PORT}`, `localhost:${MCP_PORT}`]);
  app.use((req, res, next) => {
    // Reject DNS rebinding and browser-origin requests before parsing the body.
    const walletRoute = req.path === "/wallet" || req.path.startsWith("/wallet/");
    const allowedOrigin = walletRoute && req.headers.origin === `http://127.0.0.1:${MCP_PORT}`;
    if (!allowedHosts.has(req.headers.host || "") || (req.headers.origin !== undefined && !allowedOrigin)) {
      res.status(403).json({ error: "Forbidden host or browser origin" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  if (WALLET_MODE === "browser") browserWallet.mount(app, MCP_PORT, entries, kronos);

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({
      status: "healthy",
      wallet: currentWalletAddress() || "not configured",
      wallet_mode: WALLET_MODE,
      live_entries_enabled: !entries.status().locked,
      entry_controls: entries.status(),
      protective_order_submission: "wallet_approval_required",
      timestamp: new Date().toISOString(),
    });
  });

  // MCP endpoint using StreamableHTTPServerTransport
  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer();
      // Create a new transport instance for each request
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      // Clean up transport when connection closes
      res.on("close", () => {
        void server.close();
      });

      // Connect the MCP server to this transport and handle the request
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Error handling MCP request:", errorMessage);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: errorMessage },
          id: null,
        });
      }
    }
  });

  // Start HTTP server
  app.listen(MCP_PORT, "127.0.0.1", () => {
    console.error(`\n=== Jupiter Perps MCP Server (HTTP Mode) ===`);
    console.error(`Server running on: http://localhost:${MCP_PORT}`);
    console.error(`Health check: http://localhost:${MCP_PORT}/health`);
    console.error(`MCP endpoint: http://localhost:${MCP_PORT}/mcp`);
    console.error(`Wallet: ${walletAddress}`);
    console.error(`\nReady to accept connections\n`);
  });
}

// Main entry point
async function main() {
  // Validate environment variables
  if (WALLET_MODE !== "browser" && WALLET_MODE !== "keypair") throw new Error("Unsupported WALLET_MODE");
  if (WALLET_MODE === "browser" && MCP_MODE !== "http") throw new Error("Browser wallet requires HTTP mode");
  if (WALLET_MODE === "keypair" && (!WALLET_PRIVATE_KEY || !walletKeypair)) {
    console.error("Error: WALLET_PRIVATE_KEY is missing or invalid in .env file");
    process.exit(1);
  }

  // Start server in the appropriate mode
  if (MCP_MODE === "http") {
    await startHttpServer();
  } else {
    await startStdioServer();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
