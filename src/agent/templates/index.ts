/**
 * Dyna-Trader Bot Templates Package
 *
 * Provides pre-configured trading strategies and bot implementations.
 */

export * from "./bot-templates";

// Re-export singleton instance
export { botTemplateManager as default } from "./bot-templates";

// Re-export utility functions
export { getTemplateCategories, getRiskLevels } from "./bot-templates";
