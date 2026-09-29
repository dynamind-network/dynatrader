import { useMemo, useRef, useEffect } from 'react';
import type { CommandItem } from '../common/CommandPalette.js';
import type { ExecutionMode } from '../../core/types.js';
import { dispatchScreenPaneAction } from '../layout/ScreenPaneWorkspace.js';

interface RecentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface ScreenTarget {
  id: string;
  label: string;
  screen: string;
  description: string;
}

interface CommandTarget {
  id: string;
  label: string;
  command: string;
  description: string;
}

export function useAppCommandPalette(options: {
  onSetScreen: (screen: string) => void;
  onClearSession: () => Promise<void>;
  onToggleTranscript: () => void;
  recentSessions: RecentSessionSummary[];
  onResumeSession: (id: string) => Promise<{ success: boolean; message: string }>;
  subagentSuggestions: Array<{ name: string; description?: string }>;
  onSetInput: (input: string) => void;
  executionMode: ExecutionMode;
  onApplyExecutionMode: (mode: ExecutionMode) => void;
  onSubmitCommand: (text: string) => Promise<void>;
  activeScreen: string;
}): CommandItem[] {
  const {
    onSetScreen,
    onClearSession,
    onToggleTranscript,
    recentSessions,
    onResumeSession,
    subagentSuggestions,
    onSetInput,
    executionMode,
    onApplyExecutionMode,
    onSubmitCommand,
    activeScreen,
  } = options;

  // Use a ref for onSubmitCommand to prevent cascading instability:
  // onSubmitCommand (= submitCommand) changes when commandService changes,
  // which would create new commandPaletteEntries every render, which triggers
  // setCommandPaletteItems in App.tsx, causing a re-render loop.
  const onSubmitCommandRef = useRef(onSubmitCommand);
  useEffect(() => {
    onSubmitCommandRef.current = onSubmitCommand;
  }, [onSubmitCommand]);

  const screenTargets: ScreenTarget[] = useMemo(
    () => [
      { id: 'chat', label: 'Open Chat', screen: 'chat', description: 'Main conversation' },
      { id: 'help', label: 'Open Help', screen: 'help', description: 'Commands and shortcuts' },
      {
        id: 'markets',
        label: 'Open Markets',
        screen: 'markets',
        description: 'Live prices and sparklines',
      },
      {
        id: 'portfolio',
        label: 'Open Portfolio',
        screen: 'portfolio',
        description: 'Holdings and PnL',
      },
      { id: 'trades', label: 'Open Trades', screen: 'trades', description: 'Order history' },
      { id: 'alerts', label: 'Open Alerts', screen: 'alerts', description: 'Price alerts' },
      {
        id: 'analysis',
        label: 'Open Analysis',
        screen: 'analysis',
        description: 'Technical signals',
      },
      { id: 'news', label: 'Open News', screen: 'news', description: 'Market news' },
      {
        id: 'watchlist',
        label: 'Open Watchlist',
        screen: 'watchlist',
        description: 'Tracked symbols',
      },
      { id: 'chart', label: 'Open Chart', screen: 'chart', description: 'Full-screen graph' },
      { id: 'search', label: 'Open Search', screen: 'search', description: 'Search markets' },
      {
        id: 'settings',
        label: 'Open Settings',
        screen: 'settings',
        description: 'App preferences',
      },
      { id: 'models', label: 'Open Models', screen: 'models', description: 'Switch model' },
      {
        id: 'orderbook',
        label: 'Open Depth',
        screen: 'orderbook',
        description: 'Order book depth',
      },
      {
        id: 'autohedge',
        label: 'Open AutoHedge',
        screen: 'autohedge',
        description: 'Automation control',
      },
    ],
    []
  );

  const commandTargets: CommandTarget[] = useMemo(
    () => [
      {
        id: 'help-cmd',
        label: 'Run /help',
        command: '/help',
        description: 'Show command reference',
      },
      {
        id: 'compact-cmd',
        label: 'Run /compact',
        command: '/compact',
        description: 'Summarize the session',
      },
      {
        id: 'resume-list',
        label: 'Run /resume',
        command: '/resume',
        description: 'List saved sessions',
      },
      {
        id: 'tools-cmd',
        label: 'Run /tools',
        command: '/tools',
        description: 'List available tools',
      },
      { id: 'mcp-cmd', label: 'Run /mcp', command: '/mcp', description: 'Show MCP servers' },
      {
        id: 'agents-cmd',
        label: 'Manage agents',
        command: '/agents',
        description: 'List configured agents',
      },
      {
        id: 'agents-create-cmd',
        label: 'Create agent',
        command: '/agents create',
        description: 'Start the workspace agent wizard',
      },
      {
        id: 'plan-cmd',
        label: 'Create a plan',
        command: '/plan ',
        description: 'Enter a goal for a read-only implementation plan',
      },
    ],
    []
  );

  return useMemo(() => {
    const sessionTargets = [
      {
        id: 'new-session',
        label: 'New Session',
        description: 'Clear the current chat',
        action: () => {
          void onClearSession();
        },
      },
      {
        id: 'open-transcript',
        label: 'Open Transcript',
        description: 'Inspect full history',
        action: onToggleTranscript,
      },
      {
        id: 'resume-latest',
        label: 'Resume Latest Session',
        description: recentSessions[0]
          ? `${recentSessions[0].title} \u2022 ${recentSessions[0].id}`
          : 'No saved sessions yet',
        action: () => {
          const latest = recentSessions[0];
          if (latest) {
            void onResumeSession(latest.id);
          }
        },
      },
      ...recentSessions.map((session) => ({
        id: `resume-${session.id}`,
        label: `Resume ${session.title}`,
        description: `${session.id} \u2022 ${new Date(session.updatedAt).toLocaleString()}`,
        action: () => {
          void onResumeSession(session.id);
        },
      })),
    ];

    const agentTargets = subagentSuggestions.map((agent) => ({
      id: `agent-${agent.name}`,
      label: `@${agent.name}`,
      description: agent.description || 'Delegate a task',
      action: () => {
        onSetInput(`@${agent.name} `);
      },
    }));

    return [
      ...screenTargets.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        group: 'screen' as const,
        action: () => {
          onSetScreen(item.screen);
        },
      })),
      ...commandTargets.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        group: 'command' as const,
        action: () => {
          if (item.id === 'plan-cmd') {
            onSetInput(item.command);
            return;
          }
          void onSubmitCommandRef.current(item.command);
        },
      })),
      ...sessionTargets.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        group: 'session' as const,
        action: item.action,
      })),
      ...agentTargets.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        group: 'agent' as const,
        action: item.action,
      })),
      {
        id: 'mode-normal',
        label: 'Normal Mode',
        description: 'Require confirmation for tools',
        group: 'setting' as const,
        action: () => {
          onApplyExecutionMode('normal');
        },
      },
      {
        id: 'mode-auto',
        label: 'Auto-Approve Mode',
        description: 'Approve safe tools automatically',
        group: 'setting' as const,
        action: () => {
          onApplyExecutionMode('auto-approve');
        },
      },
      {
        id: 'mode-toggle',
        label: 'Toggle Mode',
        description: 'Switch between normal and auto-approve',
        group: 'setting' as const,
        action: () => {
          onApplyExecutionMode(executionMode === 'normal' ? 'auto-approve' : 'normal');
        },
      },
      ...( ['markets', 'chart', 'portfolio', 'trades', 'news', 'analysis'].includes(activeScreen) ? [
        { id: 'pane-next', label: 'Focus next pane', description: 'Switch focus in the current screen', group: 'setting' as const, action: () => dispatchScreenPaneAction('next') },
        { id: 'pane-add', label: 'Add pane to screen', description: 'Add the next available panel', group: 'setting' as const, action: () => dispatchScreenPaneAction('add') },
        { id: 'pane-customize', label: 'Customize screen panes', description: 'Resize, reorder, or remove panels', group: 'setting' as const, action: () => dispatchScreenPaneAction('customize') },
        { id: 'pane-reset', label: 'Reset screen panes', description: 'Restore the default panel layout', group: 'setting' as const, action: () => dispatchScreenPaneAction('reset') },
      ] : []),
    ];
  }, [
    screenTargets,
    commandTargets,
    onClearSession,
    onToggleTranscript,
    recentSessions,
    onResumeSession,
    subagentSuggestions,
    onSetInput,
    onSetScreen,
    // onSubmitCommand intentionally excluded -- accessed via ref
    onApplyExecutionMode,
    executionMode,
    activeScreen,
  ]);
}
