/**
 * CLI Command: memory, compact
 */

import type { DynaTraderRuntime } from '@dyna/core/cli';
import { bold, cyan, green, red, yellow, dim, formatDate, printSeparator, printHeader } from '../utils';

export async function cmdMemory(
  runtime: DynaTraderRuntime,
  query: string | undefined,
): Promise<void> {
  const memory = runtime.getMemory();

  if (!query) {
    // Show memory stats
    printHeader('Memory Store');

    // Search for all entries to get stats
    try {
      const allEntries = await memory.search({
        scope: '',
        text: '',
        topK: 1000,
      });

      console.log(`  Total Entries: ${bold(String(allEntries.length))}`);

      // Group by scope
      const scopeCounts = new Map<string, number>();
      for (const entry of allEntries) {
        const scope = (entry.payload as Record<string, unknown>)?.scope as string || 'unknown';
        scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
      }

      if (scopeCounts.size > 0) {
        console.log();
        console.log(bold('  By Scope:'));
        for (const [scope, count] of scopeCounts) {
          console.log(`    ${scope}: ${count}`);
        }
      }

      // Recent entries
      const recent = allEntries.slice(0, 5);
      if (recent.length > 0) {
        console.log();
        console.log(bold('  Recent Entries:'));
        for (const entry of recent) {
          const ts = entry.timestamp instanceof Date
            ? formatDate(entry.timestamp)
            : String(entry.timestamp);
          console.log(
            `    ${dim(ts)} ${entry.id} (score: ${entry.score.toFixed(2)})`,
          );
          const payload = entry.payload as Record<string, unknown>;
          if (payload?.kind) {
            console.log(dim(`      kind: ${payload.kind}`));
          }
        }
      }
    } catch (err) {
      console.log(yellow(`  Could not retrieve stats: ${(err as Error).message}`));
    }

    console.log();
  } else {
    // Search memory
    printHeader(`Memory Search: "${query}"`);

    try {
      const results = await memory.search({
        scope: '',
        text: query,
        topK: 20,
      });

      if (results.length === 0) {
        console.log(yellow('  No results found.'));
      } else {
        console.log(`  Found ${results.length} results:`);
        console.log();
        for (const result of results) {
          const ts = result.timestamp instanceof Date
            ? formatDate(result.timestamp)
            : String(result.timestamp);
          console.log(
            `  ${dim(ts)} ${bold(result.id)} ${dim(`score: ${result.score.toFixed(2)}`)}`,
          );
          // Pretty-print payload
          const payloadStr = JSON.stringify(result.payload, null, 2);
          const lines = payloadStr.split('\n').slice(0, 5);
          for (const line of lines) {
            console.log(dim(`    ${line}`));
          }
          if (payloadStr.split('\n').length > 5) {
            console.log(dim('    ...'));
          }
          console.log();
        }
      }
    } catch (err) {
      console.log(red(`  Search failed: ${(err as Error).message}`));
    }

    console.log();
  }
}
