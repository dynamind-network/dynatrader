# DynaTrader benchmarks

The matrix covers nine eval families, baseline versus DynaMind harness mode, and three local models: Qwen, DeepSeek, and Llama. `benchmark-matrix.ts` records the exact planned cells; it does not fabricate scores when a model is unavailable.

```powershell
bun run evals/benchmark-matrix.ts
bun run evals/cli.ts --mode baseline --family financial_reporting --model qwen2.5
bun run evals/cli.ts --mode dynamind --family financial_reporting --model qwen2.5
bun run evals/cli.ts --compare evals/output/<baseline>.json evals/output/<dynamind>.json
```

Set `BENCHMARK_MODELS` to a comma-separated list and `BENCHMARK_OUTPUT` to change the matrix configuration. Publish results only after the corresponding JSON traces exist.
