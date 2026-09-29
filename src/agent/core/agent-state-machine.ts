import type { AgentState } from "@dyna/contracts";

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["starting", "error"],
  starting: ["running", "error"],
  running: ["tool_executing", "compacting", "stopping", "error"],
  tool_executing: ["running", "stopping", "error"],
  compacting: ["running", "stopping", "error"],
  stopping: ["idle"],
  error: ["idle", "starting"],
};

export class AgentStateMachine {
  private state: AgentState = "idle";
  private listeners: Array<(state: AgentState, prev: AgentState) => void> = [];

  getState(): AgentState { return this.state; }

  transition(newState: AgentState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid state transition: ${this.state} -> ${newState}. Allowed: ${allowed?.join(", ") ?? "none"}`);
    }
    const prev = this.state;
    this.state = newState;
    for (const listener of this.listeners) listener(newState, prev);
  }

  onStateChange(listener: (state: AgentState, prev: AgentState) => void): () => void {
    this.listeners.push(listener);
    return () => { const idx = this.listeners.indexOf(listener); if (idx >= 0) this.listeners.splice(idx, 1); };
  }
}
