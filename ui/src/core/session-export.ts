import * as fs from 'fs';
import * as path from 'path';
import type { Message } from './types.js';

export type ExportFormat = 'markdown' | 'json';

export function exportSession(
  messages: Message[],
  sessionId: string,
  title: string,
  format: ExportFormat,
  cwd: string
): { success: boolean; filePath?: string; message: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const exportDir = path.join(cwd, '.dynamind', 'exports');
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  if (format === 'json') {
    const filePath = path.join(exportDir, `${sessionId}-${timestamp}.json`);
    const data = { sessionId, title, exportedAt: new Date().toISOString(), messages };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { success: true, filePath, message: `Exported to: ${filePath}` };
  }

  const filePath = path.join(exportDir, `${sessionId}-${timestamp}.md`);
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push(`Session: ${sessionId}`);
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const role = msg.role === 'user' ? '## User' : msg.role === 'assistant' ? '## Assistant' : '### System';
    lines.push(role);
    lines.push('');
    if (typeof msg.content === 'string') {
      lines.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') lines.push(block.text);
        else if (block.type === 'tool_use') lines.push(`\`\`\`\n[${block.name}] ${JSON.stringify(block.input)}\n\`\`\``);
        else if (block.type === 'tool_result') lines.push(`\`\`\`\n${block.content}\n\`\`\``);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'));
  return { success: true, filePath, message: `Exported to: ${filePath}` };
}
