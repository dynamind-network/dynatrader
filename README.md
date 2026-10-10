<p align="center">
  <img src="https://github.com/dynamind-network/dynatrader/actions/workflows/ci.yml/badge.svg" alt="CI">
  <img src="https://img.shields.io/badge/version-3.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/platform-win%20%7C%20macos%20%7C%20linux-lightgrey" alt="Platform">
</p>

<h1 align="center">DynaTrader</h1>

<p align="center">
  <strong>Open-source trading and DeFi AI agent runtime</strong><br>
  LLM-powered agent that analyzes markets, manages risk, and executes trades across 100+ exchanges.<br>
  Paper trading, backtesting, and live trading with guarded execution.
</p>

---

## Features

- **One primary agent with optional subagents** — Add custom subagents as `.md` files in `agents/`, configure persistent subagents in `profiles.yaml`, and optionally enable pipeline collaboration modes
- **7 LLM providers** — OpenAI, Anthropic, OpenRouter, DeepSeek, Google, Ollama, LM Studio
- **100+ exchanges** — CCXT integration (Binance, Coinbase, Kraken, Hyperliquid, and more)
- **Paper mode** — Test strategies with real market data, no real money at risk
- **Backtesting** — Run strategies against historical data
- **Risk management** — Guarded execution with approval gates, position limits, and drawdown protection
- **Memory system** — SQLite-backed with FTS5 search, semantic embeddings, and cross-session persistence
- **Cron scheduling** — Automated market analysis, risk assessments, and Telegram alerts
- **Terminal UI** — Beautiful Ink/React terminal interface with real-time streaming
- **MCP integration** — Connect external tool servers for extended capabilities
- **Gateway** — Telegram and Discord bot support for remote monitoring

## Quick Start

```bash
# Install from source (npm package coming soon)
git clone https://github.com/dynamind-network/dynatrader.git
cd dynatrader
bun install
bun run build
bun link

# Initialize workspace (interactive wizard)
dynatrader init

# Run diagnostics
dynatrader doctor

# Start trading in paper mode
dynatrader trade --mode paper
```

## Installation

### Prerequisites

- **Node.js >= 22.19.0**
- **npm** or **bun** (for development)

### Install from source (recommended)

```bash
git clone https://github.com/dynamind-network/dynatrader.git
cd dynatrader
bun install
bun run build
bun link
```

## Configuration

### API Keys

Set your LLM provider API key as an environment variable:

```bash
# Choose one:
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
export DEEPSEEK_API_KEY=sk-...
export GOOGLE_API_KEY=AI...

# Or use local models (no API key needed):
# Ollama runs on localhost:11434 by default
# LM Studio runs on localhost:1234 by default
```

### Exchange Setup

For live or shadow trading, set your exchange API keys:

```bash
export BINANCE_API_KEY=your-api-key
export BINANCE_SECRET=your-api-secret
```

For a single configured CCXT exchange, the generic aliases `EXCHANGE_API_KEY` and `EXCHANGE_SECRET` are also accepted; `EXCHANGE_PASSPHRASE` is supported for venues that require one. Venue-specific variables take precedence. Set `EXCHANGE_ID` when the exchange is not specified in configuration. Generic aliases are not used when multiple exchanges are configured or for native adapters.

See `.env.example` for all available environment variables.

### State and agent workspace

The init wizard keeps private runtime state separate from editable agent-owned files:

```
~/.dynatrader/
  config.yaml          # Runtime configuration
  auth.json            # Owner and approval configuration
  auth-profiles.json   # Optional rotating model credentials
  state.db             # Sessions and trading records
  audit.jsonl          # Audit trail
  memory/              # Persistent memory store
  runs/                # Trade run history
  logs/                # Runtime logs
  cron/                # Scheduled jobs

~/.dynatrader/workspace/
  AGENTS.md            # Agent instructions
  SOUL.md              # Agent personality
  IDENTITY.md          # Agent identity
  USER.md              # Your preferences
  MEMORY.md            # Agent-owned memory
  HEARTBEAT.md         # Health check instructions
  skills/              # Learned skills
  agents/              # Sub-agent configs
  policies/            # Safety policies
```

The TUI also supports provider credentials from `~/.dynamind/auth.json`, settings, and environment variables. Keep all credentials in those stores or environment variables; do not put them in agent workspace files.

### DynaMind Data API

DynaTrader uses the hosted DynaMind Data API by default for market data, signals, risk, news, and analytics. The Free plan includes 1,000 requests/day for basic price data on one endpoint; historical OHLCV and additional endpoints require a plan that includes them. Create a free key in the [DynaMind Developer Portal](https://developer.dynamind.network/) and set `DYNAMIND_API_KEY`. Plan and quota errors are shown in the agent response, with no silent fallback. Review [plans and higher usage limits](https://dynamind.network/pricing). Set `DYNAMIND_API_URL` for a self-hosted or DynaMind-compatible API. In the standalone TUI runtime, set `DYNA_MARKET_DATA_PROVIDER=exchange` to use the configured exchange adapter instead; the full runtime also accepts replacement provider plugins in `config.yaml`.

## Usage

### Terminal UI (default)

```bash
dynatrader              # Launch TUI
dynatrader --tui        # Explicit TUI
dynatrader --no-daemon  # Use the local standalone coding agent runtime
```

### CLI Commands

```bash
dynatrader init         # Interactive workspace setup
dynatrader status       # Runtime status and health
dynatrader trade        # Run single agent turn
dynatrader backtest BTC-USDT --timeframe 1h --days 30
dynatrader pipeline     # Multi-agent trading pipeline
dynatrader agents       # List loaded agent profiles
dynatrader memory       # Show memory stats or search
dynatrader risk         # Show current risk state
dynatrader cron list    # List scheduled jobs
dynatrader mcp list     # List MCP servers
dynatrader doctor       # Diagnose environment issues
dynatrader doctor --fix # Auto-repair common issues
dynatrader gateway run  # Start daemon with gateway
dynatrader logs         # View daemon logs
dynatrader version      # Show version info
```

### JSON-RPC Gateway

```bash
dynatrader --stdio      # Start JSON-RPC gateway on stdio
```

## Architecture

```
dynatrader/
  packages/core/                 # @dyna/core SDK and runtime
    src/                         # Agent, market, risk, execution, orchestration
  packages/cli/                  # dynatrader binary and daemon
  packages/ui/                   # @dynatrader/ui terminal interface
  packages/dynamind-api-plugin/  # Independently released API plugin
  templates/workspace/           # Safe workspace setup guidance only
  evals/                         # Benchmarks and evaluation fixtures
  docs/architecture/             # Package and user-data boundaries
```

See [package and workspace layout](docs/architecture/package-and-workspace-layout.md) for release boundaries and user-data paths. Runtime code, credentials, databases, logs, and generated runs stay outside the agent workspace.

### Agent Model

DynaTrader uses **one primary agent** with optional subagents — not hardcoded roles. The primary agent reads `SOUL.md`, `IDENTITY.md`, and `USER.md` at session start. Subagents are loaded dynamically:

| Source | How to add |
|--------|-----------|
| `agents/<name>.md` | Markdown file with YAML frontmatter (OpenCode-style) |
| `agents/<name>/SOUL.md` + `profile.yaml` | Directory-based agent with full config |
| `profiles.yaml` | Persistent subagents defined under `subagents[]` |
| Runtime | Ephemeral subagents spawned via `session_spawn` or delegate task |

Multi-agent collaboration (pipeline) is **opt-in** — enabled via the `multi/` package when needed, not the default mode.

## Supported Exchanges

DynaTrader supports 100+ exchanges via CCXT, including:

| Exchange | Spot | Futures | Notes |
|----------|------|---------|-------|
| Binance | Yes | Yes | Largest volume |
| Coinbase | Yes | Yes | US-regulated |
| Kraken | Yes | Yes | European leader |
| Hyperliquid | Yes | Yes | Perps DEX |
| OKX | Yes | Yes | Global |
| Bybit | Yes | Yes | Derivatives |
| dYdX | Yes | Yes | Decentralized |
| Uniswap | Yes | No | DEX (via SDK) |

## Risk Disclaimer

**This software is for educational and research purposes only.**

- Trading cryptocurrencies and DeFi assets involves substantial risk of loss
- Past performance does not guarantee future results
- Never trade with money you cannot afford to lose
- The authors are not responsible for any financial losses incurred through use of this software
- Paper trading results do not reflect real trading conditions
- Always test thoroughly with paper mode before any live trading
- Start with small position sizes and conservative risk settings

## Development

```bash
bun install            # Install dependencies
bun run build          # Build core runtime
bun run build:ui       # Build terminal UI
bun run build:all      # Build everything
bun run typecheck      # Type check
bun run test           # Run tests
bun run release:check  # Full release gate (typecheck + build + test)
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

Third-party providers can extend the runtime without changing core code. See
[PLUGINS.md](docs/PLUGINS.md) for the capability seams, configuration rows,
tool registration contract, and exchange adapter registry.

- Setting up the development environment
- Coding standards and conventions
- Pull request process
- Commit message format

## Security

For security vulnerabilities, please see our [Security Policy](SECURITY.md). Do not open public issues for security concerns.

## Community

- [GitHub Issues](https://github.com/dynamind-network/dynatrader/issues) — Bug reports and feature requests
- [GitHub Discussions](https://github.com/dynamind-network/dynatrader/discussions) — Questions and ideas
- [Pull Requests](https://github.com/dynamind-network/dynatrader/pulls) — Contributions

## License

MIT — see [LICENSE](LICENSE) for details.
