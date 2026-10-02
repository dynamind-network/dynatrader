#!/usr/bin/env node
/**
 * Benchmark Pre-Tool Hook for DynaMind Terminal
 * Measures tool execution overhead and logs timing metrics
 *
 * Input (stdin): JSON with { toolName, toolInput, timestamp }
 * Output (stdout): JSON with benchmark results
 */

const fs = require("fs");
const path = require("path");

const BENCHMARK_LOG = path.join(
  process.env.USERPROFILE || "",
  ".dynamind",
  "benchmark",
  "pre-tool.log",
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
      const { toolName, toolInput, timestamp } = payload;

      const startTime = Date.now();
      const startMemory = process.memoryUsage().heapUsed;

      const modifiedInput = {
        ...toolInput,
        _benchmark: {
          preToolStart: startTime,
          timestamp,
          sessionId: payload.session_id || "default",
        },
      };

      const benchmarkResult = {
        modifiedInput,
        shouldBlock: false,
        benchmark: {
          toolName,
          preToolStart: startTime,
          memoryBefore: startMemory,
          hookDuration: 0,
        },
      };

      ensureDir(path.dirname(BENCHMARK_LOG));
      const logEntry =
        JSON.stringify({
          event: "preTool",
          toolName,
          timestamp: new Date().toISOString(),
          startTime,
        }) + "\n";
      fs.appendFileSync(BENCHMARK_LOG, logEntry);

      console.log(JSON.stringify(benchmarkResult));
      process.exit(0);
    } catch (error) {
      console.log(
        JSON.stringify({
          shouldBlock: false,
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
