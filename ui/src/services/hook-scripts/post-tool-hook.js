#!/usr/bin/env node
/**
 * Post-Tool Hook for Dyanamind Terminal
 * Executes after tool completion. Can log results or trigger side effects.
 *
 * Input (stdin): JSON with { toolName, toolInput, toolResult, timestamp }
 * Output (stdout): JSON with modified payload (pass-through)
 */

function main() {
  let input = "";

  process.stdin.on("data", (chunk) => {
    input += chunk;
  });

  process.stdin.on("end", async () => {
    try {
      const payload = JSON.parse(input);
      const { toolResult } = payload;

      // Log that hook was executed
      const modifiedPayload = {
        ...payload,
        _hook_executed: "post",
        _hook_timestamp: new Date().toISOString(),
      };

      console.log(JSON.stringify(modifiedPayload));
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
