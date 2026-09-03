import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from './types.js';
import { getErrorMessage } from '../utils/index.js';
import { parseJson } from '../utils/json.js';
import { DYNAMIND_DIR, getDynamindPath } from '../utils/constants.js';

export class ContextManager {
  private maxContextTokens: number;
  private compressionThreshold: number;
  private memoryDir: string;

  constructor(
    options: {
      maxContextTokens?: number;
      compressionThreshold?: number;
      memoryDir?: string;
    } = {}
  ) {
    this.maxContextTokens = options.maxContextTokens || 200000;
    this.compressionThreshold = options.compressionThreshold || 0.92;
    this.memoryDir = options.memoryDir || DYNAMIND_DIR;
  }

  estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return sum + Math.ceil(content.length / 4);
    }, 0);
  }

  getUsagePercent(messages: Message[]): number {
    return this.estimateTokens(messages) / this.maxContextTokens;
  }

  needsCompression(messages: Message[]): boolean {
    return this.getUsagePercent(messages) > this.compressionThreshold;
  }

  async compress(messages: Message[]): Promise<{
    compressed: Message[];
    summary: string;
  }> {
    if (messages.length < 10) {
      return { compressed: messages, summary: '' };
    }

    const toSummarize = messages.slice(0, -10);
    const toKeep = messages.slice(-10);

    const summary = this.createSummary(toSummarize);
    await this.saveToMemory(toSummarize);

    const compressed: Message[] = [
      {
        role: 'user',
        content: `[Previous conversation summary]\n${summary}\n\n[Continuing conversation...]`,
      },
      ...toKeep,
    ];

    return { compressed, summary };
  }

  private createSummary(messages: Message[]): string {
    const lines: string[] = [];

    let userQuestions = 0;
    const toolsUsed = new Set<string>();
    const keyTopics: string[] = [];

    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      if (msg.role === 'user') {
        userQuestions++;
        const firstLine = content.split('\n')[0].slice(0, 100);
        if (firstLine) keyTopics.push(firstLine);
      }

      if (typeof msg.content !== 'string') {
        for (const block of msg.content) {
          if ('type' in block && block.type === 'tool_use' && 'name' in block) {
            toolsUsed.add(block.name as string);
          }
        }
      }
    }

    lines.push(`Messages summarized: ${messages.length}`);
    lines.push(`User queries: ${userQuestions}`);

    if (toolsUsed.size > 0) {
      lines.push(`Tools used: ${Array.from(toolsUsed).join(', ')}`);
    }

    if (keyTopics.length > 0) {
      lines.push(`Key topics:`);
      keyTopics.slice(-5).forEach((topic) => {
        lines.push(`  - ${topic}`);
      });
    }

    return lines.join('\n');
  }

  private async saveToMemory(messages: Message[]): Promise<void> {
    const memoryPath = path.join(this.memoryDir, 'conversation-history.md');
    const MAX_FILE_SIZE = 5 * 1024 * 1024;

    try {
      await fs.mkdir(this.memoryDir, { recursive: true });

      let existingSize = 0;
      try {
        const stat = await fs.stat(memoryPath);
        existingSize = stat.size;
      } catch {
        // File doesn't exist yet
      }

      if (existingSize >= MAX_FILE_SIZE) {
        const backupPath = memoryPath.replace('.md', `-${Date.now()}.md`);
        await fs.rename(memoryPath, backupPath);
        existingSize = 0;
      }

      const timestamp = new Date().toISOString();
      const content = [
        `\n## Session ${timestamp}\n`,
        ...messages.map((msg) => {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return `**${msg.role}**: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}\n`;
        }),
      ].join('\n');

      await fs.appendFile(memoryPath, content);
    } catch (err) {
      console.error('Failed to save to memory:', err);
    }
  }

  async loadMemory(): Promise<string | null> {
    const memoryPath = path.join(this.memoryDir, 'conversation-history.md');

    try {
      const content = await fs.readFile(memoryPath, 'utf-8');
      return content.slice(-5000);
    } catch {
      return null;
    }
  }

  async clearMemory(): Promise<void> {
    const memoryPath = path.join(this.memoryDir, 'conversation-history.md');

    try {
      await fs.unlink(memoryPath);
    } catch (err) {
      console.warn('[ContextManager] Failed to clear memory:', getErrorMessage(err));
    }
  }

  async saveProjectNotes(notes: string): Promise<void> {
    const notesPath = path.join(this.memoryDir, 'project-notes.md');

    try {
      await fs.mkdir(this.memoryDir, { recursive: true });
      await fs.writeFile(notesPath, notes);
    } catch (err) {
      console.error('Failed to save project notes:', err);
    }
  }

  async loadProjectNotes(): Promise<string | null> {
    const notesPath = path.join(this.memoryDir, 'project-notes.md');

    try {
      return await fs.readFile(notesPath, 'utf-8');
    } catch {
      return null;
    }
  }
}

export class SessionManager {
  private sessionDir: string;

  constructor(sessionDir: string = getDynamindPath('sessions')) {
    this.sessionDir = sessionDir;
  }

  async saveSession(
    sessionId: string,
    state: {
      messages: Message[];
      metadata: Record<string, unknown>;
    }
  ): Promise<void> {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);

    try {
      await fs.mkdir(this.sessionDir, { recursive: true });
      await fs.writeFile(sessionPath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to save session:', err);
      throw err;
    }
  }

  async loadSession(sessionId: string): Promise<{
    messages: Message[];
    metadata: Record<string, unknown>;
  } | null> {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);

    try {
      const content = await fs.readFile(sessionPath, 'utf-8');
      return parseJson(content) ?? null;
    } catch {
      return null;
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.sessionDir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);

    try {
      await fs.unlink(sessionPath);
    } catch (err) {
      console.warn('[ContextManager] Failed to delete session:', getErrorMessage(err));
    }
  }
}
