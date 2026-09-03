import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Watcher {
  id: string;
  command: string;
  pattern: string;
  cwd: string;
  pid?: number;
  active: boolean;
  lastOutput: string;
  lastRun: number;
}

const WATCHERS_FILE = '.dynamind/watchers.json';

function loadWatchers(cwd: string): Watcher[] {
  const filePath = path.join(cwd, WATCHERS_FILE);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // ignore malformed watcher state and fall through to the default
  }
  return [];
}

function saveWatchers(cwd: string, watchers: Watcher[]): void {
  const filePath = path.join(cwd, WATCHERS_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(watchers, null, 2));
}

let watcherIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

export function startWatcher(
  cwd: string,
  pattern: string,
  command: string
): Watcher {
  const watchers = loadWatchers(cwd);
  const id = `w-${Date.now().toString(36)}`;

  const watcher: Watcher = {
    id,
    command,
    pattern,
    cwd,
    active: true,
    lastOutput: '',
    lastRun: Date.now(),
  };

  watchers.push(watcher);
  saveWatchers(cwd, watchers);

  const interval = setInterval(() => {
    try {
      const output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        windowsHide: true,
      }).trim();

      if (output !== watcher.lastOutput) {
        watcher.lastOutput = output;
        watcher.lastRun = Date.now();
        saveWatchers(cwd, watchers);
      }
    } catch (error: any) {
      watcher.lastOutput = error.stderr || error.message || 'Command failed';
      watcher.lastRun = Date.now();
      saveWatchers(cwd, watchers);
    }
  }, 2000);

  watcherIntervals.set(id, interval);

  return watcher;
}

export function stopWatcher(cwd: string, watcherId: string): boolean {
  const watchers = loadWatchers(cwd);
  const idx = watchers.findIndex((w) => w.id === watcherId);
  if (idx === -1) return false;

  watchers[idx].active = false;
  saveWatchers(cwd, watchers);

  const interval = watcherIntervals.get(watcherId);
  if (interval) {
    clearInterval(interval);
    watcherIntervals.delete(watcherId);
  }

  return true;
}

export function listWatchers(cwd: string): Watcher[] {
  return loadWatchers(cwd);
}

export function stopAllWatchers(cwd: string): void {
  const watchers = loadWatchers(cwd);
  for (const w of watchers) {
    const interval = watcherIntervals.get(w.id);
    if (interval) clearInterval(interval);
  }
  watcherIntervals.clear();
  for (const w of watchers) w.active = false;
  saveWatchers(cwd, watchers);
}

export function getWatcherOutput(cwd: string, watcherId: string): string | null {
  const watchers = loadWatchers(cwd);
  const watcher = watchers.find((w) => w.id === watcherId);
  return watcher?.lastOutput ?? null;
}
