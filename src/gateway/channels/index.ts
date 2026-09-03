/**
 * Dyna-Trader Channels Core Package
 *
 * Provides session management, channel routing, and operator interfaces.
 */

export * from "./sessions";
export * from "./channels";
export * from "./gateway";
export * from "./operator-inbox";

// Re-export key types
export type { Session, SessionMetadata, SessionState, SessionEvent } from "./sessions";
export type { Channel, ChannelMembership, ChannelEvent, ChannelFilter } from "./channels";
export type { GatewayConfig, GatewayMetrics, UserSession } from "./gateway";
export type { InboxMessage, InboxAction, InboxFilter, NotificationSettings } from "./operator-inbox";

// Export main classes
export { SessionManager } from "./sessions";
export { ChannelManager } from "./channels";
export { GatewayService } from "./gateway";
export { OperatorInbox } from "./operator-inbox";
