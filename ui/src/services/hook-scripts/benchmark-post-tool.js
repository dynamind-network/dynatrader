#!/usr/bin/env node
/**
 * Benchmark Post-Tool Hook for DynaMind Terminal
 * Logs tool execution completion and metrics
 *
 * Input (stdin): JSON with { toolName, toolInput, toolResult, timestamp }
 * Output (stdout): JSON with benchmark results
 */

const fs = require("fs");
const path = require("path");

const BENCHMARK_LOG = path.join(
  process.env.USERPROFILE || "",
  ".dynamind",
  "benchmark",
  "post-tool.log",
);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function main() {
  let input = "";

  process.stdin.on("data", (chunk) => {
    input += chunk;
  });

  process.stdin.on("end", async () => {
    try {
      const payload = JSON.parse(input);
      const { toolName, toolInput, toolResult, timestamp } = payload;

      const endTime = Date.now();
      const endMemory = process.memoryUsage().heapUsed;

      const preToolBenchmark = toolInput?._benchmark || {};

      const duration = preToolBenchmark.preToolStart
        ? endTime - preToolBenchmark.preToolStart
        : 0;

      const modifiedPayload = {
        ...payload,
        _benchmark: {
          postToolEnd: endTime,
          toolDuration: duration,
          memoryDelta: endMemory - (preToolBenchmark.memoryBefore || 0),
          success: toolResult?.success ?? true,
        },
      };

      const benchmarkResult = {
        modifiedInput: modifiedPayload,
        benchmark: {
          toolName,
          duration,
          memoryDelta: endMemory - (preToolBenchmark.memoryBefore || 0),
          success: toolResult?.success ?? true,
        },
      };

      ensureDir(path.dirname(BENCHMARK_LOG));
      const logEntry =
        JSON.stringify({
          event: "postTool",
          toolName,
          timestamp: new Date().toISOString(),
          endTime,
          duration,
          success: toolResult?.success ?? true,
        }) + "\n";
      fs.appendFileSync(BENCHMARK_LOG, logEntry);

      console.log(JSON.stringify(benchmarkResult));
      process.exit(0);
    } catch (error) {
      console.log(
        JSON.stringify({
          error: error.message,
        }),
      );
      process.exit(0);
    }
  });
}

if (require.main === module) {
  main();
}
