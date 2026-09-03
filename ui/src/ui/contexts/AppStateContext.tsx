import React, { createContext, useContext, useState, type ReactNode } from 'react';
import type { CatalogModel, EffortLevel } from '../../core/providers/catalog.js';
import { listCatalogModels } from '../../core/providers/catalog.js';
import type { ExecutionMode } from '../../core/types.js';
import type { Message } from '../types.js';
import type { Plan } from '../../core/plan-manager.js';

// ---------------------------------------------------------------------------
// Model State
// ---------------------------------------------------------------------------

interface ModelStateContextType {
  currentModel: string | null;
  setCurrentModel: React.Dispatch<React.SetStateAction<string | null>>;
  catalogModels: CatalogModel[];
  setCatalogModels: React.Dispatch<React.SetStateAction<CatalogModel[]>>;
  selectedModelIndex: number;
  setSelectedModelIndex: React.Dispatch<React.SetStateAction<number>>;
  effort: EffortLevel;
  setEffort: React.Dispatch<React.SetStateAction<EffortLevel>>;
  effortIndex: number;
  setEffortIndex: React.Dispatch<React.SetStateAction<number>>;
  modelPickerPhase: 'models' | 'effort';
  setModelPickerPhase: React.Dispatch<React.SetStateAction<'models' | 'effort'>>;
  pendingEffortModelId: string | null;
  setPendingEffortModelId: React.Dispatch<React.SetStateAction<string | null>>;
  executionMode: ExecutionMode;
  setExecutionMode: React.Dispatch<React.SetStateAction<ExecutionMode>>;
}

const ModelStateContext = createContext<ModelStateContextType | null>(null);

interface ModelStateProviderProps {
  children: ReactNode;
  initialModel: string | null;
}

export function ModelStateProvider({ children, initialModel }: ModelStateProviderProps) {
  const [currentModel, setCurrentModel] = useState<string | null>(initialModel);
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>(() => listCatalogModels({}));
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [effort, setEffort] = useState<EffortLevel>('none');
  const [effortIndex, setEffortIndex] = useState(0);
  const [modelPickerPhase, setModelPickerPhase] = useState<'models' | 'effort'>('models');
  const [pendingEffortModelId, setPendingEffortModelId] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('normal');

  const value: ModelStateContextType = {
    currentModel,
    setCurrentModel,
    catalogModels,
    setCatalogModels,
    selectedModelIndex,
    setSelectedModelIndex,
    effort,
    setEffort,
    effortIndex,
    setEffortIndex,
    modelPickerPhase,
    setModelPickerPhase,
    pendingEffortModelId,
    setPendingEffortModelId,
    executionMode,
    setExecutionMode,
  };

  return <ModelStateContext.Provider value={value}>{children}</ModelStateContext.Provider>;
}

export function useModelState(): ModelStateContextType {
  const context = useContext(ModelStateContext);
  if (!context) {
    throw new Error('useModelState must be used within a ModelStateProvider');
  }
  return context;
}

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

interface SessionStateContextType {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  sessionCreatedAt: string;
  setSessionCreatedAt: React.Dispatch<React.SetStateAction<string>>;
  isSwitchingSession: boolean;
  setIsSwitchingSession: React.Dispatch<React.SetStateAction<boolean>>;
  pendingPlan: Plan | null;
  setPendingPlan: React.Dispatch<React.SetStateAction<Plan | null>>;
}

const SessionStateContext = createContext<SessionStateContextType | null>(null);

interface SessionStateProviderProps {
  children: ReactNode;
}

export function SessionStateProvider({ children }: SessionStateProviderProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionCreatedAt, setSessionCreatedAt] = useState(() => new Date().toISOString());
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);

  const value: SessionStateContextType = {
    messages,
    setMessages,
    sessionCreatedAt,
    setSessionCreatedAt,
    isSwitchingSession,
    setIsSwitchingSession,
    pendingPlan,
    setPendingPlan,
  };

  return <SessionStateContext.Provider value={value}>{children}</SessionStateContext.Provider>;
}

export function useSessionState(): SessionStateContextType {
  const context = useContext(SessionStateContext);
  if (!context) {
    throw new Error('useSessionState must be used within a SessionStateProvider');
  }
  return context;
}
