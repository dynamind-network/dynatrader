export {
  parseMention,
  getMentionSuggestions,
  formatAgentHelp,
  formatFileMentionHelp,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  extractAgentMentions,
  parseAtMentionedFileLines,
  processFileMentions,
  generateFileAttachment,
  getFileSuggestions,
  type ParsedMention,
  type MentionParseResult,
  type FileMentionParseResult,
  type FileAttachment,
} from './mention-parser.js';

// Re-export number formatting utilities
export {
  NumberFormat,
  formatPrice,
  formatQuantity,
  formatPercent,
  formatPnL,
} from './number-formatting.js';

// Re-export project detection utilities
export { findProjectRoot, getProjectDirectory } from './project-detection.js';

// Re-export validation utilities
export { getErrorMessage, ValidationError, Validation } from './validation.js';

// Re-export JSON utilities
export { stringifyJson, parseJson } from './json.js';

// Re-export constants
export { LIMITS } from './constants.js';

// Re-export output scrubbing utilities (TASK-007)
export {
  scrubCredentials,
  containsCredentials,
  redactValue,
  scrubObject,
} from './output-scrubbing.js';

// Re-export tool permissions utilities (TASK-008)
export {
  checkToolPermission,
  filterToolsForAgent,
  getAllowedTools,
  getDeniedTools,
  isWriteTool,
  getAgentDescription,
  type AgentType,
} from './tool-permissions.js';

// Re-export security audit utilities (TASK-009)
export {
  scanForCredentials,
  hasCredentials,
  checkRequiredEnvVars,
  isSecureConfig,
  auditFile,
  auditFiles,
} from './security-audit.js';

