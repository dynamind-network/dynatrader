export enum AgentState {
  IDLE = 'idle',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  ERROR = 'error',
}

export interface AgentStateMachine {
  setState(newState: AgentState): void;
  checkStateTimeout(onTimeout: () => void): void;
  forceCleanup(onAbort: () => void): void;
  get state(): AgentState;
  get running(): boolean;
}

const STATE_TIMEOUT = 120000;

export function createAgentStateMachine(
  onStateChange?: (oldState: AgentState, newState: AgentState) => void
): AgentStateMachine {
  let state: AgentState = AgentState.IDLE;
  let stateChangeTime = 0;

  return {
    setState(newState: AgentState): void {
      const oldState = state;
      state = newState;
      stateChangeTime = Date.now();
      onStateChange?.(oldState, newState);
    },

    checkStateTimeout(onTimeout: () => void): void {
      const now = Date.now();
      const timeInState = now - stateChangeTime;
      if (timeInState > STATE_TIMEOUT && state !== AgentState.IDLE) {
        onTimeout();
      }
    },

    forceCleanup(onAbort: () => void): void {
      onAbort();
    },

    get state(): AgentState {
      return state;
    },

    get running(): boolean {
      return state === AgentState.RUNNING || state === AgentState.STARTING;
    },
  };
}

