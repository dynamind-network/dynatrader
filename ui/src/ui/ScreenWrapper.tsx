import React from 'react';
import { useInput } from 'ink';
import type { ScreenType } from './screens/index.js';

interface ScreenWrapperProps {
  activeScreen: ScreenType;
  children: React.ReactNode;
  onScreenInput?: (input: string, key: any) => void;
}

/**
 * Wrapper component to ensure consistent hook order across all screens
 * This prevents React hook errors when switching between screens
 */
export function ScreenWrapper({ activeScreen, children, onScreenInput }: ScreenWrapperProps) {
  // Always call useInput hook to maintain hook order consistency
  useInput((input, key) => {
    // Let the active screen handle its own input
    if (onScreenInput) {
      onScreenInput(input, key);
    }
  });

  return <>{children}</>;
}