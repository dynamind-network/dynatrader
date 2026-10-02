import {
  type Checkpoint,
  getCheckpointManager,
} from './git-checkpoint.js';

export interface UndoRedoEntry {
  checkpointId: string;
  label: string;
  timestamp: number;
}

export class UndoRedoManager {
  private undoStack: UndoRedoEntry[] = [];
  private redoStack: UndoRedoEntry[] = [];
  private maxStack = 50;

  push(checkpoint: Checkpoint): void {
    this.undoStack.push({
      checkpointId: checkpoint.id,
      label: checkpoint.label,
      timestamp: checkpoint.timestamp,
    });
    this.redoStack = [];
    if (this.undoStack.length > this.maxStack) {
      this.undoStack.shift();
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(cwd: string, sessionId: string): { success: boolean; message: string } {
    if (!this.canUndo()) {
      return { success: false, message: 'Nothing to undo' };
    }

    const entry = this.undoStack.pop()!;
    const manager = getCheckpointManager(cwd, sessionId);
    const result = manager.revertToCheckpoint(entry.checkpointId);

    if (result.success) {
      this.redoStack.push(entry);
    }

    return result;
  }

  redo(cwd: string, sessionId: string): { success: boolean; message: string } {
    if (!this.canRedo()) {
      return { success: false, message: 'Nothing to redo' };
    }

    const entry = this.redoStack.pop()!;
    const manager = getCheckpointManager(cwd, sessionId);
    const result = manager.revertToCheckpoint(entry.checkpointId);

    if (result.success) {
      this.undoStack.push(entry);
    }

    return result;
  }

  getUndoDescription(): string | null {
    if (!this.canUndo()) return null;
    const entry = this.undoStack[this.undoStack.length - 1]!;
    return entry.label;
  }

  getRedoDescription(): string | null {
    if (!this.canRedo()) return null;
    const entry = this.redoStack[this.redoStack.length - 1]!;
    return entry.label;
  }

  getUndoCount(): number {
    return this.undoStack.length;
  }

  getRedoCount(): number {
    return this.redoStack.length;
  }
}

const globalUndoRedo = new UndoRedoManager();

export function getUndoRedoManager(): UndoRedoManager {
  return globalUndoRedo;
}

