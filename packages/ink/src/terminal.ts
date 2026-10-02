/** The renderer-facing API used by the DynaTrader terminal UI. */
export type { RenderOptions, Instance } from './render.js';
export { default as render } from './render.js';
export type { Props as BoxProps } from './components/Box.js';
export { default as Box } from './components/Box.js';
export type { Props as TextProps } from './components/Text.js';
export { default as Text } from './components/Text.js';
export type { Props as StaticProps } from './components/Static.js';
export { default as Static } from './components/Static.js';
export type { Key } from './hooks/use-input.js';
export { default as useInput } from './hooks/use-input.js';
export { default as useStdout } from './hooks/use-stdout.js';
export { default as measureElement } from './measure-element.js';
export type { DOMElement } from './dom.js';
export {
  clearTerminalSelection,
  finishTerminalSelection,
  getSelectedTerminalText,
  getTerminalSelection,
  startTerminalSelection,
  updateTerminalSelection,
  selectTerminalLine,
  selectTerminalWord,
} from './terminal-selection.js';
export type { TerminalPoint, TerminalSelection } from './terminal-selection.js';
