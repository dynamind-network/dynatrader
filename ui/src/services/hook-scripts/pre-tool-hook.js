#!/usr/bin/env node
/**
 * Pre-Tool Hook for Dyanamind Terminal
 * Executes before any tool execution. Can log, validate, or transform input.
 *
 * Input (stdin): JSON with { toolName, toolInput, timestamp }
 * Output (stdout): JSON with { modifiedInput, shouldBlock, message }
 */

function main() {
  let input = "";

  process.stdin.on("data", (chunk) => {
    input += chunk;
  });

  process.stdin.on("end", async () => {
    try {
      const payload = JSON.parse(input);
      const { toolName, toolInput } = payload;

      // Add hook execution marker
      const modifiedInput = {
        ...toolInput,
        _hook_executed: "pre",
      };

      // Log the hook execution
      console.log(
        JSON.stringify({
          modifiedInput,
          shouldBlock: false,
          timestamp: new Date().toISOString(),
        }),
      );

      process.exit(0);
    } catch (error) {
      // On error, pass through unchanged
      console.log(input);
      process.exit(0);
    }
  });
}

if (require.main === module) {
  main();
}
