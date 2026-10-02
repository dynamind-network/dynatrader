/**
 * Dyna-Trader Gateway Package
 *
 * Manages WebSocket/HTTP connections, session mapping, message routing,
 * rate limiting, authentication, broadcasting, auditing, and health checks.
 */

export {
  Gateway,
  type ConnectionType,
  type ConnectionInfo,
  type RateLimitConfig,
  type GatewayOptions,
  type HealthStatus,
  type AccessResult,
  type MessageHandler,
} from "./gateway";
