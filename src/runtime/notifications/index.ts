/**
 * Dyna-Trader Notification Runtime Package
 *
 * Multi-channel notification dispatch with template rendering and
 * severity-based routing. Supports dynamic channel registration,
 * configurable severity thresholds, and comprehensive audit logging.
 */

export {
  NotificationRuntime,
  renderTemplate,
  renderNotification,
  filterChannelsBySeverity,
  severityRank,
  meetsSeverityThreshold,
  DEFAULT_CHANNELS,
  type NotificationSeverity,
  type TemplateVariables,
  type RenderedNotification,
  type ChannelConfig,
  type Notification,
  type DispatchResult,
  type DispatchSummary,
  type RuntimeOpts,
  type SendOptions,
  type ChannelHandler,
} from "./notification-runtime";
