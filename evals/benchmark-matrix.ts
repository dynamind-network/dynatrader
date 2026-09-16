import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const families = ['market_understanding', 'tool_selection', 'financial_reporting', 'web_research', 'trading_decision', 'spreadsheet', 'multi_agent', 'memory', 'secure_tool_use'];
const modes = ['baseline', 'dynamind'];
const models = (process.env.BENCHMARK_MODELS ?? 'qwen2.5,deepseek-r1,llama3.1').split(',').map(s => s.trim()).filter(Boolean);
const output = process.env.BENCHMARK_OUTPUT ?? 'evals/output';
const generatedAt = new Date().toISOString();
const matrix = families.flatMap(family => modes.flatMap(mode => models.map(model => ({ family, mode, model, status: 'pending', generatedAt }))));
mkdirSync(output, { recursive: true });
const file = join(output, `benchmark-matrix-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ methodology: 'Run evals/cli.ts for each row against the configured local model endpoint.', matrix }, null, 2));
console.log(`Benchmark matrix: ${matrix.length} runs planned`);
console.log(`Output: ${file}`);
console.log('Run with: bun run evals/cli.ts --mode <baseline|dynamind> --family <family> --model <model>');
