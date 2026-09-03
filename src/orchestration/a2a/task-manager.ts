import { v4 as uuid } from "uuid";
import type { Task, TaskState, A2AMessage } from "./types";

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private sessionTasks: Map<string, Set<string>> = new Map();

  createTask(sessionId: string, initialState?: Partial<Task["status"]>): Task {
    const task: Task = {
      id: uuid(),
      sessionId,
      status: {
        state: initialState?.state ?? "submitted",
        message: initialState?.message,
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: {},
    };
    this.tasks.set(task.id, task);
    
    const sessionTaskSet = this.sessionTasks.get(sessionId) ?? new Set();
    sessionTaskSet.add(task.id);
    this.sessionTasks.set(sessionId, sessionTaskSet);
    
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  updateState(taskId: string, state: TaskState, message?: A2AMessage): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    
    task.history.push({ ...task.status });
    task.status = {
      state,
      message,
      timestamp: new Date().toISOString(),
    };
    
    return task;
  }

  getSessionTasks(sessionId: string): Task[] {
    const taskIds = this.sessionTasks.get(sessionId) ?? new Set();
    return Array.from(taskIds).map(id => this.tasks.get(id)!).filter(Boolean);
  }

  addArtifact(taskId: string, artifact: unknown): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.artifacts.push(artifact);
    }
  }

  cancelTask(taskId: string): Task | undefined {
    return this.updateState(taskId, "canceled");
  }
}
