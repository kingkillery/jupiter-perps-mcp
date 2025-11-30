# Jupiter Perps MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that enables AI agents to trade perpetual futures on [Jupiter Perpetuals](https://jup.ag/perps) (Solana).

> **⚠️ DISCLAIMER**
> This software is provided for educational and research purposes only. Trading perpetual futures involves substantial risk of loss and is not suitable for all investors. You are solely responsible for any trading decisions and losses incurred. The authors and contributors assume no liability for your use of this software. Use at your own risk with funds you can afford to lose.

## Features

- **Market Data**: Real-time prices, 24h statistics, and historical OHLCV candles
- **Portfolio Management**: View USDC balance, open positions, PnL, and fees
- **Position Trading**: Open, increase, and close leveraged positions (1.1x - 100x)
- **Fee Estimation**: Calculate trading costs before execution
- **Transaction Safety**: Automatic compute budget optimization and simulation

Supported assets: SOL, ETH, BTC

## How It Works

Jupiter Perpetuals uses an **oracle-based** pricing model with a shared liquidity pool:

- **Pricing**: Trades execute at oracle prices (Signal/Chainlink/Pyth), not order book prices
- **Liquidity**: You trade against a pool of SOL, ETH, WBTC, USDC, USDT (not against other traders)
- **Slippage Protection**: `MAX_SLIPPAGE_BPS` protects against oracle price movement during transaction execution
- **Fees**:
  - Base trading fee + Price impact fee (protects liquidity providers)
  - Hourly borrow fees (instead of traditional funding rates)

This means large trades don't suffer from order book depth issues, but oracle price slippage can still occur if prices move during transaction confirmation.

## Key Concepts

**Position Model**: Positions are identified by asset + side (e.g., "Long SOL"). You can only have one position per asset/side pair. The protocol automatically merges any additional opens into the existing position, increasing its size and adjusting entry price.

**Collateral**: All positions use USDC as collateral. For long positions, the protocol swaps USDC to the asset internally.

**Fees**: Trading fees (base + price impact) are paid when opening/increasing/closing positions. Borrow fees accrue hourly and are settled when modifying/closing. Use `estimate_open_position` before trading to understand total costs.

**Trading**: All trades execute at market price immediately (no limit orders). Tools return a transaction signature for logging purposes. The protocol processes positions asynchronously in a separate transaction - this may take a few seconds and can fail. Use `get_account_portfolio` to verify the position was successfully created.

## Prerequisites

- Node.js 18+
- A Solana wallet with USDC for trading
- Wallet private key (base58 encoded)

## Installation

```bash
git clone <repository-url>
cd jupiter-perps-mcp
npm install
npm run build
```

## Configuration

Create a `.env` file:

```bash
cp .env.example .env
```

Required settings:
```env
WALLET_PRIVATE_KEY=your_base58_encoded_private_key
RPC_URL=https://api.mainnet-beta.solana.com
```

Optional settings:
```env
MAX_SLIPPAGE_BPS=200                    # Default: 200 (2%)
PRIORITY_FEE_MICRO_LAMPORTS=100000      # Default: 100000
```

## Usage

### Local Testing

Quick verification with MCP inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

### With Claude Code (Local)

Create `.mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "jupiter-perps": {
      "command": "node",
      "args": ["/absolute/path/to/jupiter-perps-mcp/dist/index.js"]
    }
  }
}
```

Or use `${workspaceFolder}` for relative paths:

```json
{
  "mcpServers": {
    "jupiter-perps": {
      "command": "node",
      "args": ["${workspaceFolder}/jupiter-perps-mcp/dist/index.js"]
    }
  }
}
```

### Remote Setup (Sandboxed Environment)

Run the MCP server as an HTTP service to isolate sensitive wallet keys from Claude Code. The wallet private key stays on the host machine, while Claude Code runs in a separate environment and can only trade through MCP tools.

**1. On the host machine (with wallet access), configure `.env`:**

```env
MCP_PORT=3000                           # HTTP server port (default: 3000)
```

**2. Start in HTTP mode:**

```bash
npm run start:remote
```

Or set `MCP_MODE=http` in `.env` for deployment/automation.

**3. In your sandboxed Claude Code environment, create `.mcp.json`:**

```json
{
  "mcpServers": {
    "jupiter-perps": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For different machines, replace `localhost` with the host IP (e.g., `http://192.168.1.100:3000/mcp`).

**Security**: The server binds to localhost by default. For remote access, use SSH tunneling, VPN, or firewall rules to control access.

**4. Test the connection:**
```bash
curl http://localhost:3000/health
```

## Available Tools

### Market Data & Trading

| Tool | Description |
|------|-------------|
| `get_market_snapshot` | Current market prices, 24h stats, fees, and liquidity |
| `get_candles` | Historical OHLCV data (5m, 15m, 1h, 4h, 1d, 1w) |
| `get_account_portfolio` | USDC balance, positions, PnL, and fees to close |
| `estimate_open_position` | Calculate fees and resulting position before trading |
| `open_position` | Open or increase a leveraged position |
| `close_position` | Close an existing position at market price |

### Technical Indicators

| Tool | Description |
|------|-------------|
| `get_indicator_rsi` | RSI momentum oscillator (0-100, >70 overbought, <30 oversold) |
| `get_indicator_macd` | MACD trend and momentum indicator |
| `get_indicator_bollinger_bands` | Bollinger Bands volatility and mean reversion indicator |
| `get_indicator_atr` | ATR volatility measure for stop-loss placement |
| `get_indicator_ema` | Exponential Moving Average (faster than SMA) |
| `get_indicator_sma` | Simple Moving Average (classic trend indicator) |
| `get_indicator_stochastic` | Stochastic momentum oscillator (0-100, >80 overbought, <20 oversold) |

## Security

⚠️ **Important Safety Notes**

- Never commit your `.env` file
- Use a dedicated wallet with limited funds
- All positions use USDC as collateral
- Review transaction details before confirming
- Consider using a private RPC endpoint for production

## License

MIT
