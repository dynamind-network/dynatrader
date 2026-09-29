import { spawn, type ChildProcess } from 'child_process';
import { mkdir, appendFile, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import { classifyShellCommand } from '../../../security/shell-command-policy.js';

type TaskState = 'running' | 'completed' | 'failed' | 'cancelled';
interface BackgroundTask {
  id: string; command: string; cwd: string; startedAt: string; completedAt?: string;
  status: TaskState; exitCode?: number | null; logPath: string; process?: ChildProcess;
}

/** Runtime-scoped shell job manager. Logs and task metadata survive TUI/RPC disconnects. */
export class ShellTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  constructor(private readonly directory: string) {}
  get taskDirectory(): string { return this.directory; }

  async start(command: string, cwd: string, shell: { command: string; args: string[] }): Promise<BackgroundTask> {
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID();
    const logPath = path.join(this.directory, `${id}.log`);
    await writeFile(logPath, `# ${command}\n# cwd: ${cwd}\n`, 'utf8');
    const task: BackgroundTask = { id, command, cwd, startedAt: new Date().toISOString(), status: 'running', logPath };
    const child = spawn(shell.command, shell.args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    task.process = child;
    this.tasks.set(id, task);
    child.stdout?.on('data', (chunk: Buffer) => { void appendFile(logPath, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { void appendFile(logPath, chunk); });
    child.on('error', (error) => { void appendFile(logPath, `\n[process error] ${error.message}\n`); task.status = 'failed'; task.completedAt = new Date().toISOString(); });
    child.on('close', (code, signal) => {
      task.exitCode = code;
      task.status = task.status === 'cancelled' ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      task.completedAt = new Date().toISOString();
      void appendFile(logPath, `\n[${task.status}; exit=${code ?? 'null'}${signal ? `; signal=${signal}` : ''}]\n`);
    });
    return task;
  }

  async adopt(child: ChildProcess, command: string, cwd: string, stdout: string, stderr: string): Promise<BackgroundTask> {
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID(); const logPath = path.join(this.directory, `${id}.log`);
    await writeFile(logPath, `# ${command}\n# cwd: ${cwd}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, 'utf8');
    const task: BackgroundTask = { id, command, cwd, startedAt: new Date().toISOString(), status: 'running', logPath, process: child };
    this.tasks.set(id, task);
    child.once('close', (code) => { task.exitCode = code; task.status = task.status === 'cancelled' ? 'cancelled' : code === 0 ? 'completed' : 'failed'; task.completedAt = new Date().toISOString(); });
    return task;
  }

  async getOutput(id: string, tailBytes = 16000): Promise<string> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task ${id}. Use task_list to see active tasks.`);
    const data = await readFile(task.logPath, 'utf8');
    return `${data.length > tailBytes ? `[showing last ${tailBytes} characters]\n` : ''}${data.slice(-tailBytes)}\nTask ${id}: ${task.status}`;
  }

  stop(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running' || !task.process) return false;
    task.status = 'cancelled';
    this.killProcessTree(task.process);
    return true;
  }

  killProcessTree(child: ChildProcess): void {
    if (process.platform === 'win32' && child.pid) {
      // taskkill terminates the process tree (PowerShell may have launched children).
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }

  list(): Array<Omit<BackgroundTask, 'process'>> {
    return [...this.tasks.values()].map(({ process: _process, ...task }) => task).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

export interface ExecToolConfig {
  /** Deprecated compatibility fields; shell execution policy is enforced by tool permissions. */
  allowlist?: string[];
  blocklist?: string[];
  maxOutputLength?: number;
  defaultCwd?: string;
  workspaceRoot?: string;
  taskDirectory?: string;
  backgroundAfterMs?: number;
  taskManager?: ShellTaskManager;
}

export class ExecTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'exec',
    description: `Run a command in the detected native shell (${process.platform === 'win32' ? 'PowerShell' : 'Bash'}). Supports normal shell syntax. Set run_in_background=true for long-running commands; eligible commands automatically move to the background after 15 seconds. Use task_output/task_list/task_stop to inspect or manage them.`,
    category: 'exec',
    inputSchema: { command: 'string', timeout: 'number?', workdir: 'string?', run_in_background: 'boolean?' },
    outputSchema: { stdout: 'string', stderr: 'string', exitCode: 'number', taskId: 'string?' },
    permissionsRequired: ['tool.exec'], sideEffects: ['executes_commands'], riskLevel: 'high', timeoutMs: 30 * 60_000,
  };
  readonly taskManager: ShellTaskManager;
  private maxOutputLength: number;
  private defaultCwd?: string;
  private workspaceRoot: string;
  private backgroundAfterMs: number;

  constructor(config?: ExecToolConfig) {
    this.maxOutputLength = config?.maxOutputLength ?? 16 * 1024 * 1024;
    this.defaultCwd = config?.defaultCwd;
    this.workspaceRoot = config?.workspaceRoot ?? config?.defaultCwd ?? process.cwd();
    this.taskManager = config?.taskManager ?? new ShellTaskManager(config?.taskDirectory ?? path.join(this.workspaceRoot, '.dynatrader', 'tasks'));
    this.backgroundAfterMs = config?.backgroundAfterMs ?? 15_000;
  }

  async execute(call: ToolCall, context?: { signal?: AbortSignal }): Promise<ToolResult> {
    const started = Date.now();
    const command = call.args.command;
    if (typeof command !== 'string' || !command.trim()) return this.fail('Command must be a non-empty string', started);
    const safety = classifyShellCommand(command);
    if (safety.decision === 'block') return this.fail(`Blocked: ${safety.reason}`, started);
    if (context?.signal?.aborted) return this.fail('Command cancelled before start.', started);
    try {
      const cwd = this.resolveWorkdir(call.args.workdir as string | undefined);
      const shell = this.resolveShell(command);
      const timeout = (call.args.timeout as number | undefined) ?? this.definition.timeoutMs;
      const bg = call.args.run_in_background === true;
      if (bg) {
        const task = await this.taskManager.start(command, cwd, shell);
        return { success: true, stdout: `Started background task ${task.id}. Output: ${task.logPath}`, durationMs: Date.now() - started, truncated: false };
      }

      const child = spawn(shell.command, shell.args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
      let autoTask: BackgroundTask | undefined;
      const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer): void => {
        const value = chunk.toString('utf8');
        if (target === 'stdout') stdout = this.appendBounded(stdout, value); else stderr = this.appendBounded(stderr, value);
      };
      child.stdout?.on('data', collect('stdout'));
      child.stderr?.on('data', collect('stderr'));
      const abort = (): void => { this.taskManager.killProcessTree(child); };
      context?.signal?.addEventListener('abort', abort, { once: true });
      const backgroundTimer = setTimeout(async () => {
        if (settled || child.exitCode !== null) return;
        // Move a live process under a task ID and continue capturing its output to disk.
        autoTask = await this.adopt(child, command, cwd, stdout, stderr);
        child.stdout?.removeAllListeners('data'); child.stderr?.removeAllListeners('data');
        child.stdout?.on('data', (chunk: Buffer) => { void appendFile(autoTask!.logPath, chunk); });
        child.stderr?.on('data', (chunk: Buffer) => { void appendFile(autoTask!.logPath, chunk); });
      }, this.backgroundAfterMs);
      const outcome = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        timer = setTimeout(() => { this.taskManager.killProcessTree(child); resolve({ code: null, error: new Error(`Command timed out after ${timeout}ms`) }); }, timeout);
        child.once('error', (error) => resolve({ code: null, error }));
        child.once('close', (code) => resolve({ code }));
      });
      settled = true; clearTimeout(backgroundTimer); if (timer) clearTimeout(timer);
      context?.signal?.removeEventListener('abort', abort);
      if (autoTask) {
        autoTask.status = outcome.code === 0 ? 'completed' : context?.signal?.aborted ? 'cancelled' : 'failed';
        autoTask.exitCode = outcome.code; autoTask.completedAt = new Date().toISOString();
        await appendFile(autoTask.logPath, `\n[${autoTask.status}; exit=${outcome.code}]\n`);
        return { success: true, stdout: `Command continued as background task ${autoTask.id}. Current output:\n${(await this.taskManager.getOutput(autoTask.id)).slice(-5000)}`, durationMs: Date.now() - started, truncated: false };
      }
      if (context?.signal?.aborted) return { success: false, error: 'Command cancelled by user.', stdout, stderr, durationMs: Date.now() - started, truncated: false };
      return { success: !outcome.error && outcome.code === 0, stdout, stderr, ...(outcome.error ? { error: outcome.error.message } : outcome.code !== 0 ? { error: `Shell exited with code ${outcome.code}` } : {}), durationMs: Date.now() - started, truncated: false };
    } catch (error) { return this.fail(error instanceof Error ? error.message : String(error), started); }
  }

  private resolveShell(command: string): { command: string; args: string[] } {
    if (process.platform === 'win32') {
      const pwsh = process.env['DYNA_POWERSHELL_PATH'] ?? (process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'PowerShell', '7', 'pwsh.exe') : '');
      const shell = pwsh && existsSync(pwsh) ? pwsh : 'powershell.exe';
      const script = `try { & {\n${command}\n}; if (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } } catch { Write-Error $_; exit 1 }`;
      return { command: shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] };
    }
    const shell = process.env['DYNA_BASH_PATH'] ?? 'bash';
    return { command: shell, args: ['-lc', command] };
  }

  private async adopt(child: ChildProcess, command: string, cwd: string, stdout: string, stderr: string): Promise<BackgroundTask> {
    return this.taskManager.adopt(child, command, cwd, stdout, stderr);
  }

  private appendBounded(current: string, value: string): string {
    const next = current + value;
    if (next.length <= this.maxOutputLength) return next;
    return next.slice(-(this.maxOutputLength));
  }

  private resolveWorkdir(workdir?: string): string {
    const resolved = workdir ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(this.workspaceRoot, workdir)) : path.resolve(this.defaultCwd ?? this.workspaceRoot);
    const root = path.resolve(this.workspaceRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Workdir traversal blocked: '${resolved}' is outside '${root}'`);
    return resolved;
  }

  private fail(error: string, started: number): ToolResult { return { success: false, error, durationMs: Date.now() - started, truncated: false }; }
}

export class TaskOutputTool implements ToolHandler {
  readonly definition: ToolDefinition = { name: 'task_output', description: 'Read the latest output for a background shell task by task_id.', category: 'exec', inputSchema: { task_id: 'string', tail_bytes: 'number?' }, outputSchema: { output: 'string' }, permissionsRequired: ['tool.exec'], sideEffects: [], riskLevel: 'low', timeoutMs: 5_000 };
  constructor(private manager: ShellTaskManager) {}
  async execute(call: ToolCall): Promise<ToolResult> { try { return { success: true, data: await this.manager.getOutput(String(call.args.task_id), Number(call.args.tail_bytes) || 16000), durationMs: 0, truncated: false }; } catch (error) { return { success: false, error: String(error), durationMs: 0, truncated: false }; } }
}

export class TaskListTool implements ToolHandler {
  readonly definition: ToolDefinition = { name: 'task_list', description: 'List shell tasks started in this runtime, including their status and log paths.', category: 'exec', inputSchema: {}, outputSchema: { tasks: 'array' }, permissionsRequired: ['tool.exec'], sideEffects: [], riskLevel: 'low', timeoutMs: 5_000 };
  constructor(private manager: ShellTaskManager) {}
  async execute(): Promise<ToolResult> { return { success: true, data: this.manager.list(), durationMs: 0, truncated: false }; }
}

export class TaskStopTool implements ToolHandler {
  readonly definition: ToolDefinition = { name: 'task_stop', description: 'Stop a running background shell task by task_id.', category: 'exec', inputSchema: { task_id: 'string' }, outputSchema: { stopped: 'boolean' }, permissionsRequired: ['tool.exec'], sideEffects: ['executes_commands'], riskLevel: 'medium', timeoutMs: 5_000 };
  constructor(private manager: ShellTaskManager) {}
  async execute(call: ToolCall): Promise<ToolResult> { const stopped = this.manager.stop(String(call.args.task_id)); return { success: stopped, data: { stopped }, durationMs: 0, truncated: false, ...(stopped ? {} : { error: 'Task was not found or is no longer running.' }) }; }
}
