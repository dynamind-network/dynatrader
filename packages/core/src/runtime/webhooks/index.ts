/**
 * Dyna-Trader Webhook Runtime Package
 *
 * Webhook runtime for inbound/outbound webhooks with HMAC-SHA256 signature
 * verification, source IP/domain allowlisting, and event-to-action mapping.
 */

export {
  WebhookRuntime,
  type WebhookSourceConfig,
  type InboundWebhookPayload,
  type OutboundWebhookPayload,
  type WebhookResult,
  type WebhookRuntimeOptions,
} from "./webhook-runtime";

export { WebhookRuntime as default } from "./webhook-runtime";
