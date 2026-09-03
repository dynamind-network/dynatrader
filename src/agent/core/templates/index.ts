/**
 * Agent Core Templates
 *
 * Export bootstrap and conversation templates used by the agent core.
 */

export { BOOTSTRAP_RITUAL_TEMPLATE } from './bootstrap-ritual';
export type {
  BootstrapRitualTemplate,
  Message as BootstrapMessage,
  BootstrapCompletionCheck,
} from './bootstrap-ritual';
export { extractOperatorName, extractAgentName } from './bootstrap-ritual';
