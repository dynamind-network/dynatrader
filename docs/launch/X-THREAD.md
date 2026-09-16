# Launch thread draft

1. DynaTrader 3.0 is a composable trading-agent harness: capabilities mount as plugins, tool access is profiled, and providers can be replaced by layer.

2. The builtin exchange and wallet plugins keep paper mode offline-capable while configured providers can override market data.

3. MCP servers now connect over stdio or HTTP and their tools appear in the local registry as `mcp.<server>.<tool>`.

4. The eval suite covers market understanding, tool selection, financial reporting, web research, trading decisions, spreadsheets, multi-agent work, memory, and secure tool use.

5. Reproduce the benchmark matrix with `bun run evals/benchmark-matrix.ts`. Scores will be published only from checked-in traces.

6. Open source under MIT. Contributions and provider plugins are welcome.
