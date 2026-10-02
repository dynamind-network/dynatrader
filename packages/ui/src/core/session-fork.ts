import * as fs from 'fs';
import * as path from 'path';

export interface SessionData {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: any[];
  metadata: {
    model: string;
    executionMode: string;
    effort: string;
    title: string;
    chatMessages: any[];
  };
}

export function forkSession(
  sessionsDir: string,
  sourceSessionId: string,
  newTitle?: string
): { success: boolean; sessionId?: string; message: string } {
  const sourcePath = path.join(sessionsDir, `${sourceSessionId}.json`);
  if (!fs.existsSync(sourcePath)) {
    return { success: false, message: `Session ${sourceSessionId} not found` };
  }

  try {
    const source: SessionData = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
    const newId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const forked: SessionData = {
      ...source,
      id: newId,
      title: newTitle ?? `${source.title} (fork)`,
      createdAt: now,
      updatedAt: now,
      metadata: {
        ...source.metadata,
        title: newTitle ?? `${source.title} (fork)`,
      },
    };

    const newPath = path.join(sessionsDir, `${newId}.json`);
    fs.writeFileSync(newPath, JSON.stringify(forked, null, 2));

    return { success: true, sessionId: newId, message: `Forked to session: ${newId}` };
  } catch (error: any) {
    return { success: false, message: `Fork failed: ${error.message}` };
  }
}

