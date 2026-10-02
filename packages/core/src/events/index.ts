/**
 * Dyna-Trader Event Bus Package
 *
 * Provides centralized event handling for the entire system.
 */

export * from "./event-bus";

// Re-export the singleton instance
export { eventBus as default } from "./event-bus";

// Re-export utility functions
export { createEvent, emitTrade, emitRisk, emitAgent, emitChannel } from "./event-bus";