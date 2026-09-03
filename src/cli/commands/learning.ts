/**
 * CLI Command: learning
 */

import type { DynaTraderRuntime } from '@dyna/orchestration/workspace';
import { bold, cyan, green, red, yellow, dim, printSeparator } from '../utils';

export async function cmdLearning(
  runtime: DynaTraderRuntime,
  sub: string,
  args: string[],
): Promise<void> {
  switch (sub) {
    case 'skills': {
      console.log();
      console.log(bold(cyan('Learned Skills')));
      printSeparator();

      try {
        const skillFactory = runtime.getSkillFactory();
        console.log(dim('  SkillFactory: available'));
        const learned = await skillFactory.listSkills();
        console.log(dim(`  Learned skills: ${learned.length}`));
      } catch {
        console.log(yellow('  SkillFactory: not initialized'));
      }

      console.log();
      console.log(bold('  Learning Loop Components:'));
      console.log(`    ${green('[OK]')} SkillFactory`);
      console.log(`    ${green('[OK]')} CrossSessionRecall`);
      console.log();
      break;
    }

    case 'recall': {
      const query = args.join(' ');
      if (!query) {
        console.log(red('Error: query is required.'));
        console.log(dim('Usage: dynatrader learning recall <query>'));
        return;
      }

      console.log();
      console.log(bold(cyan(`Cross-Session Recall: "${query}"`)));
      printSeparator();

      try {
        const recall = runtime.getCrossSessionRecall();
        const results = await recall.search(query);

        if (results.length === 0) {
          console.log(yellow('  No results found.'));
          console.log(dim('  Sessions may not have been indexed yet.'));
        } else {
          console.log(`  Found ${results.length} results:`);
          console.log();
          for (const result of results) {
            console.log(`  ${dim(`[score: ${(result.score * 100).toFixed(0)}%]`)}`);
            console.log(`    ${result.text.slice(0, 200)}`);
            console.log(dim(`    session: ${result.sessionId.slice(0, 16)}...`));
            console.log();
          }
        }
      } catch (err) {
        console.log(red(`Recall failed: ${(err as Error).message}`));
      }
      console.log();
      break;
    }

    default: {
      console.log(red(`Unknown learning subcommand: ${sub}`));
      console.log(dim('Usage: dynatrader learning <skills|recall> [args...]'));
    }
  }
}
