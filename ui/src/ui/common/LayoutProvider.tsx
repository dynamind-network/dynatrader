import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
} from "react";
import { Box, Text } from "ink";

export type LayoutMode = "chat" | "dashboard" | "analysis" | "execution";

export interface PanelConfig {
  id: string;
  title: string;
  defaultSize: number;
  minSize: number;
  maxSize: number;
  visible: boolean;
}

export interface LayoutState {
  mode: LayoutMode;
  panelSizes: Record<string, number>;
  isDirty: boolean;
}

export interface LayoutContextValue {
  mode: LayoutMode;
  setMode: (mode: LayoutMode) => void;
  panelSizes: Record<string, number>;
  setPanelSize: (panelId: string, size: number) => void;
  getPanelConfig: (panelId: string) => PanelConfig | undefined;
  resetLayout: () => void;
}

const defaultPanelConfigs: PanelConfig[] = [
  {
    id: "positions",
    title: "Positions",
    defaultSize: 30,
    minSize: 10,
    maxSize: 50,
    visible: true,
  },
  {
    id: "watchlist",
    title: "Watchlist",
    defaultSize: 20,
    minSize: 5,
    maxSize: 40,
    visible: true,
  },
  {
    id: "orders",
    title: "Orders",
    defaultSize: 25,
    minSize: 10,
    maxSize: 40,
    visible: true,
  },
  {
    id: "alerts",
    title: "Alerts",
    defaultSize: 15,
    minSize: 5,
    maxSize: 30,
    visible: true,
  },
  {
    id: "chart",
    title: "Chart",
    defaultSize: 40,
    minSize: 20,
    maxSize: 60,
    visible: true,
  },
];

const defaultPanelSizes: Record<string, number> = defaultPanelConfigs.reduce(
  (acc, config) => ({ ...acc, [config.id]: config.defaultSize }),
  {},
);

const LayoutContext = createContext<LayoutContextValue | null>(null);

interface LayoutProviderProps {
  children: React.ReactNode;
  initialMode?: LayoutMode;
}

export function LayoutProvider({
  children,
  initialMode = "chat",
}: LayoutProviderProps) {
  const [mode, setModeState] = useState<LayoutMode>(initialMode);
  const [panelSizes, setPanelSizesState] =
    useState<Record<string, number>>(defaultPanelSizes);
  const [isDirty, setIsDirty] = useState(false);

  const setMode = useCallback((newMode: LayoutMode) => {
    setModeState(newMode);
    setIsDirty(true);
  }, []);

  const setPanelSize = useCallback((panelId: string, size: number) => {
    setPanelSizesState((prev) => ({
      ...prev,
      [panelId]: size,
    }));
    setIsDirty(true);
  }, []);

  const getPanelConfig = useCallback((panelId: string) => {
    return defaultPanelConfigs.find((p) => p.id === panelId);
  }, []);

  const resetLayout = useCallback(() => {
    setPanelSizesState(defaultPanelSizes);
    setModeState("chat");
    setIsDirty(false);
  }, []);

  const value = useMemo(
    () => ({
      mode,
      setMode,
      panelSizes,
      setPanelSize,
      getPanelConfig,
      resetLayout,
    }),
    [mode, setMode, panelSizes, setPanelSize, getPanelConfig, resetLayout],
  );

  return (
    <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
  );
}

export function useLayout(): LayoutContextValue {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error("useLayout must be used within a LayoutProvider");
  }
  return context;
}

export function usePanelSize(panelId: string): number {
  const { panelSizes, getPanelConfig } = useLayout();
  const config = getPanelConfig(panelId);
  return panelSizes[panelId] ?? config?.defaultSize ?? 20;
}
