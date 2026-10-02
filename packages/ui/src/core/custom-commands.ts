import * as fs from 'fs';
import * as path from 'path';

export interface CustomCommand {
  name: string;
  description: string;
  prompt: string;
  filePath: string;
}

const COMMANDS_DIR = '.dynamind/commands';

export function loadCustomCommands(cwd: string): CustomCommand[] {
  const commandsDir = path.join(cwd, COMMANDS_DIR);
  if (!fs.existsSync(commandsDir)) return [];

  const commands: CustomCommand[] = [];
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(commandsDir, file), 'utf-8');
      const name = path.basename(file, '.md');
      const lines = content.split('\n');
      const description = lines[0]?.replace(/^#\s*/, '').trim() || `Custom command: ${name}`;
      const prompt = lines.slice(1).join('\n').trim();

      commands.push({
        name,
        description,
        prompt,
        filePath: path.join(commandsDir, file),
      });
    } catch {
      // Skip files that can't be read
    }
  }

  return commands;
}

export function getCustomCommand(cwd: string, name: string): CustomCommand | null {
  const commands = loadCustomCommands(cwd);
  return commands.find((c) => c.name === name) || null;
}

