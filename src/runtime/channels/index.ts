/**
 * Dyna-Trader Channel Runtime Package
 *
 * Manages channel lifecycle (start/stop/restart), loads channel manifests
 * from workspace/channels/*.channel.json, routes inbound messages,
 * enforces permissions and blocked operations, and audits all events.
 */

export {
  ChannelRuntime,
  ChannelManifestSchema,
  type ChannelManifest,
  type ChannelState,
  type ChannelRuntimeOptions,
} from "./channel-runtime";
