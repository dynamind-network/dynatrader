# DynaTrader plugins

DynaTrader uses a capability-first plugin contract. A plugin is a module whose
default export is a factory receiving the row configuration and returning a
`DynaPlugin`. The runtime mounts the plugin, exposes its registered services to
consumers, and automatically removes registered tools, listeners, and services
when the plugin is unloaded.

```ts
import type { DynaPlugin, MarketDataProvider } from "dynatrader";

export default function createMarketPlugin(
  config: Record<string, unknown>,
): DynaPlugin {
  const provider: MarketDataProvider = {
    async fetchUniverse() { return ["BTC/USDT"]; },
    async getPrice(_symbol) { return 0; },
    async getOHLCV(_symbol, _timeframe, _limit) { return []; },
    async getOrderBook(_symbol) { return { bids: [], asks: [], timestamp: Date.now() }; },
    async get24hVolume(_symbol) { return 0; },
  };

  return {
    id: "my-market-data",
    version: "1.0.0",
    description: "Example market-data provider",
    capabilities: ["market_data"],
    init(ctx) {
      ctx.registerService("market_data", provider);
      ctx.registerTool(
        {
          name: "my_market_status",
          description: "Read provider status",
          category: "market",
          inputSchema: {},
          readOnly: true,
        },
        async () => ({ provider: ctx.id, configured: Boolean(config.apiKey) }),
      );
    },
  };
}
```

Add the plugin to a workspace `config.yaml`:

```yaml
plugins:
  - id: my-market-data
    entry: /absolute/path/to/my-market-data/dist/index.js
    config:
      endpoint: "https://provider.example/api"
```

Later composition rows replace earlier rows with the same id or capability.
This enables providers for market data, signals, risk, news, exchanges,
wallets, DEX routing, gas estimation, backtests, and other future seams
without modifying the DynaTrader core. Plugins should read credentials from
environment variables rather than storing them in this file, and must declare
side effects and permissions for every tool they register.

Exchange plugins may register `exchange` for the default venue and
`exchange_adapters` for a read-only map of all configured venue adapters. The
execution router consumes that map and does not know whether an adapter is
built-in, bundled, or supplied by a third party.
