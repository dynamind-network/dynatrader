import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DYNAMIND_DIR } from '../../utils/constants.js';
import { COLORS } from '../design/tokens.js';

export interface ScreenPaneDefinition {
  id: string;
  title: string;
  content: React.ReactNode;
}

export interface ScreenPaneLayoutState {
  panes: string[];
  split: number;
}

export interface PaneViewport {
  width: number;
  height: number;
}

export type PaneWorkspaceAction = 'customize' | 'add' | 'remove' | 'next' | 'reset';

export interface ScreenPaneController {
  layout: ScreenPaneLayoutState;
  focusedPaneId: string;
  isEditing: boolean;
  menuOpen: boolean;
  error: string | null;
  viewportFor(paneId: string): PaneViewport;
  isInputActive(paneId: string): boolean;
  runAction(action: PaneWorkspaceAction): void;
}

const MAX_PANES = 4;
const DEFAULT_SPLIT = 62;
const MAX_LAYOUT_FILE_BYTES = 128 * 1024;

let activeActions: ((action: PaneWorkspaceAction) => void) | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function dispatchScreenPaneAction(action: PaneWorkspaceAction): void {
  activeActions?.(action);
}

export function normalizePaneLayout(
  value: unknown,
  availableIds: string[],
  defaults: string[],
): ScreenPaneLayoutState {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const requested = Array.isArray(record.panes) ? record.panes : defaults;
  const panes = [...new Set(requested.filter((id): id is string =>
    typeof id === 'string' && availableIds.includes(id)
  ))].slice(0, MAX_PANES);
  const validPanes = panes.length ? panes : defaults.filter((id) => availableIds.includes(id)).slice(0, 1);
  const split = typeof record.split === 'number' && Number.isFinite(record.split)
    ? Math.max(30, Math.min(75, Math.round(record.split)))
    : DEFAULT_SPLIT;
  return { panes: validPanes, split };
}

export function getPaneViewport(
  layout: ScreenPaneLayoutState,
  paneId: string,
  focusedPaneId: string,
  terminalSize: PaneViewport,
): PaneViewport {
  const multiple = layout.panes.length > 1;
  const twoUp = multiple && layout.panes.length === 2 && terminalSize.width >= 160;
  if (!twoUp && multiple && paneId !== focusedPaneId) return { width: 0, height: 0 };
  const outerWidth = twoUp
    ? layout.panes.indexOf(paneId) === 0
      ? Math.floor(terminalSize.width * layout.split / 100)
      : terminalSize.width - Math.floor(terminalSize.width * layout.split / 100) - 1
    : terminalSize.width;
  return {
    width: Math.max(24, outerWidth - (multiple ? 4 : 0)),
    height: Math.max(8, terminalSize.height - (multiple ? 5 : 1)),
  };
}

async function readLayouts(file: string): Promise<Record<string, unknown>> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_LAYOUT_FILE_BYTES) return {};
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function layoutFile(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), DYNAMIND_DIR, 'screen-layouts.json');
}

export function useScreenPaneController(options: {
  screenId: string;
  workspaceDir?: string;
  terminalSize: PaneViewport;
  paneIds: string[];
  defaultPanes: string[];
}): ScreenPaneController {
  const { screenId, workspaceDir = process.cwd(), terminalSize, paneIds, defaultPanes } = options;
  const file = useMemo(() => layoutFile(workspaceDir), [workspaceDir]);
  const idsKey = paneIds.join('\u0000');
  const defaultsKey = defaultPanes.join('\u0000');
  const [layout, setLayout] = useState(() => normalizePaneLayout(null, paneIds, defaultPanes));
  const [ready, setReady] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusedPaneId, setFocusedPaneId] = useState(defaultPanes[0] ?? paneIds[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  const focusedRef = useRef(focusedPaneId);
  layoutRef.current = layout;
  focusedRef.current = focusedPaneId;

  useEffect(() => {
    let alive = true;
    setReady(false);
    void readLayouts(file).then((all) => {
      if (!alive) return;
      const next = normalizePaneLayout(all[screenId], idsKey.split('\u0000'), defaultsKey.split('\u0000'));
      setLayout(next);
      setFocusedPaneId(next.panes[0] ?? '');
      setReady(true);
    });
    return () => { alive = false; };
  }, [file, screenId, idsKey, defaultsKey]);

  const persist = useCallback((next: ScreenPaneLayoutState) => {
    setLayout(next);
    layoutRef.current = next;
    setError(null);
    writeQueue = writeQueue.then(async () => {
      const all = await readLayouts(file);
      all[screenId] = next;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        await fs.rename(temp, file);
      } catch (writeError) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw writeError;
      }
    }).catch((writeError: unknown) => {
      setError(writeError instanceof Error ? writeError.message : 'Could not save pane layout');
    });
  }, [file, screenId]);

  const runAction = useCallback((action: PaneWorkspaceAction) => {
    const current = layoutRef.current;
    const focusedIndex = current.panes.indexOf(focusedRef.current);
    if (action === 'customize') {
      setIsEditing((value) => !value);
      setMenuOpen(false);
      return;
    }
    if (action === 'next') {
      const nextIndex = (focusedIndex + 1 + current.panes.length) % current.panes.length;
      setFocusedPaneId(current.panes[nextIndex] ?? '');
      return;
    }
    if (action === 'reset') {
      const defaults = defaultsKey.split('\u0000').filter((id) => idsKey.split('\u0000').includes(id));
      persist({ panes: defaults.slice(0, MAX_PANES), split: DEFAULT_SPLIT });
      setFocusedPaneId(defaults[0] ?? '');
      setIsEditing(false);
      setMenuOpen(false);
      return;
    }
    if (action === 'add') {
      const nextId = idsKey.split('\u0000').find((id) => !current.panes.includes(id));
      if (nextId && current.panes.length < MAX_PANES) {
        persist({ ...current, panes: [...current.panes, nextId] });
        setFocusedPaneId(nextId);
      }
      setMenuOpen(false);
      return;
    }
    if (action === 'remove' && current.panes.length > 1 && focusedIndex >= 0) {
      const next = current.panes.filter((_, index) => index !== focusedIndex);
      persist({ ...current, panes: next });
      setFocusedPaneId(next[Math.min(focusedIndex, next.length - 1)] ?? '');
      setMenuOpen(false);
    }
  }, [defaultsKey, idsKey, persist]);

  useEffect(() => {
    if (!ready) return;
    const handler = (action: PaneWorkspaceAction) => runAction(action);
    activeActions = handler;
    return () => {
      if (activeActions === handler) activeActions = null;
    };
  }, [ready, runAction]);

  useInput((input, key) => {
    if (!ready) return;
    const chord = input.toLowerCase();
    const current = layoutRef.current;
    if (menuOpen) {
      if (key.escape || input === '.') setMenuOpen(false);
      else if (chord === 'a') runAction('add');
      else if (chord === 'x') runAction('remove');
      else if (chord === 'r') runAction('reset');
      else if (key.tab) runAction('next');
      return;
    }
    if (input === '.' && !key.ctrl && !key.meta) {
      setMenuOpen(true);
      return;
    }
    if (key.tab && current.panes.length > 1) {
      runAction('next');
      return;
    }
    if (key.ctrl && key.shift && chord === 'o') {
      runAction('customize');
      return;
    }
    if (!isEditing) return;
    const focusedIndex = current.panes.indexOf(focusedRef.current);
    if (key.ctrl && key.shift && chord === 'h') {
      setFocusedPaneId(current.panes[Math.max(0, focusedIndex - 1)] ?? focusedRef.current);
    } else if (key.ctrl && key.shift && chord === 'l') {
      setFocusedPaneId(current.panes[Math.min(current.panes.length - 1, focusedIndex + 1)] ?? focusedRef.current);
    } else if (key.ctrl && key.shift && chord === 'n') runAction('add');
    else if (key.ctrl && key.shift && chord === 'x') runAction('remove');
    else if (key.ctrl && key.shift && chord === 'k' && focusedIndex > 0) {
      const next = [...current.panes];
      [next[focusedIndex - 1], next[focusedIndex]] = [next[focusedIndex], next[focusedIndex - 1]];
      persist({ ...current, panes: next });
      setFocusedPaneId(next[focusedIndex - 1] ?? '');
    } else if (key.ctrl && key.shift && chord === 'j' && focusedIndex < current.panes.length - 1) {
      const next = [...current.panes];
      [next[focusedIndex + 1], next[focusedIndex]] = [next[focusedIndex], next[focusedIndex + 1]];
      persist({ ...current, panes: next });
      setFocusedPaneId(next[focusedIndex + 1] ?? '');
    } else if (key.ctrl && key.shift && chord === '[') persist({ ...current, split: Math.max(30, current.split - 5) });
    else if (key.ctrl && key.shift && chord === ']') persist({ ...current, split: Math.min(75, current.split + 5) });
    else if (key.escape) setIsEditing(false);
  });

  const viewportFor = useCallback((paneId: string) =>
    getPaneViewport(layout, paneId, focusedPaneId, terminalSize),
  [focusedPaneId, layout, terminalSize]);

  const isInputActive = useCallback((paneId: string) =>
    ready && !menuOpen && layout.panes.includes(paneId) && (layout.panes.length === 1 || focusedPaneId === paneId),
  [focusedPaneId, layout.panes, menuOpen, ready]);

  return { layout, focusedPaneId, isEditing, menuOpen, error, viewportFor, isInputActive, runAction };
}

/** Screen-level panes are opt-in; mounting this never changes the AI chat layout. */
export function ScreenPaneWorkspace({
  controller,
  terminalSize,
  panes,
}: {
  controller: ScreenPaneController;
  terminalSize: PaneViewport;
  panes: ScreenPaneDefinition[];
}) {
  const visible = controller.layout.panes
    .map((id) => panes.find((pane) => pane.id === id))
    .filter((pane): pane is ScreenPaneDefinition => Boolean(pane));
  const twoUp = visible.length === 2 && terminalSize.width >= 160;
  const displayed = twoUp ? visible : visible.filter((pane) => pane.id === controller.focusedPaneId);

  return (
    <Box flexDirection="column" width={terminalSize.width} height={terminalSize.height} overflow="hidden">
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {displayed.map((pane) => {
          const index = visible.findIndex((item) => item.id === pane.id);
          const size = controller.viewportFor(pane.id);
          const focused = controller.focusedPaneId === pane.id;
          return (
            <Box
              key={pane.id}
              flexDirection="column"
              width={twoUp ? index === 0 ? Math.floor(terminalSize.width * controller.layout.split / 100) : terminalSize.width - Math.floor(terminalSize.width * controller.layout.split / 100) - 1 : terminalSize.width}
              height={terminalSize.height - 1}
              flexShrink={0}
              overflow="hidden"
            >
              {visible.length === 1 && !controller.isEditing ? pane.content : (
                <Box paddingX={1} borderStyle="round" borderColor={focused ? COLORS.accent : COLORS.muted} flexDirection="column" flexGrow={1} overflow="hidden">
                  <Text color={focused ? COLORS.accent : COLORS.primary} bold>{pane.title}</Text>
                  <Box width={size.width} height={size.height} flexDirection="column" flexGrow={1} overflow="hidden">{pane.content}</Box>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      {controller.menuOpen ? (
        <Text color={COLORS.accent}>PANE MENU · [A]dd [X] close [R] reset [Tab] next [.] close menu</Text>
      ) : (
        <Text dimColor>
          {controller.error ? `Layout save failed: ${controller.error}` : controller.isEditing
            ? 'LAYOUT · Ctrl+Shift+H/L focus · Ctrl+Shift+N add · Ctrl+Shift+X close · Ctrl+Shift+J/K move · Ctrl+Shift+[/] resize · Esc done'
            : visible.length > 1
              ? `Pane ${visible.findIndex((pane) => pane.id === controller.focusedPaneId) + 1}/${visible.length} · Tab switch · . actions · Ctrl+Shift+O layout`
              : '· pane actions · Ctrl+Shift+O layout'}
        </Text>
      )}
    </Box>
  );
}
