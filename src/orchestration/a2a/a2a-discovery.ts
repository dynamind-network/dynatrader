/**
 * A2A Discovery
 *
 * Workspace-configurable agent discovery system.
 * Allows agents to discover and connect to other agents
 * either locally (in-process) or remotely (via HTTP).
 *
 * Configuration in workspace config.yaml:
 * ```yaml
 * a2a:
 *   enabled: true
 *   peers:
 *     - name: researcher
 *       url: http://localhost:9100
 *       authToken: optional-token
 *     - name: analyst
 *       url: http://192.168.1.100:9100
 *   discovery:
 *     mode: workspace  # workspace | network | both
 *     broadcast: false
 * ```
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type { AgentCard } from './types';
import { A2AClient, createA2AClient } from './a2a-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2ADiscoveryConfig {
  /** Whether A2A is enabled. */
  enabled: boolean;
  /** Known peers (static configuration). */
  peers: A2APeerConfig[];
  /** Discovery mode. */
  discovery: {
    /** Discovery mode: workspace (static), network (mDNS/SSDP), or both. */
    mode: 'workspace' | 'network' | 'both';
    /** Whether to broadcast this agent's availability. */
    broadcast: boolean;
    /** Broadcast interval in ms. Default: 60000. */
    broadcastIntervalMs?: number;
  };
}

export interface A2APeerConfig {
  /** Peer name (unique identifier). */
  name: string;
  /** Peer URL (e.g., http://localhost:9100). */
  url: string;
  /** Authentication token. Optional. */
  authToken?: string;
  /** Request timeout in ms. Default: 30000. */
  timeoutMs?: number;
  /** Capabilities this peer offers. */
  capabilities?: string[];
}

export interface A2ADiscoveredPeer {
  /** Peer config. */
  config: A2APeerConfig;
  /** Agent Card (fetched on discovery). */
  card?: AgentCard;
  /** Client for communicating with this peer. */
  client: A2AClient;
  /** Last seen timestamp. */
  lastSeen: number;
  /** Whether the peer is currently reachable. */
  reachable: boolean;
}

export interface A2ADiscoveryStatus {
  enabled: boolean;
  mode: string;
  peersConfigured: number;
  peersDiscovered: number;
  peersReachable: number;
}

// ---------------------------------------------------------------------------
// A2ADiscovery
// ---------------------------------------------------------------------------

export class A2ADiscovery {
  private config: A2ADiscoveryConfig;
  private peers: Map<string, A2ADiscoveredPeer> = new Map();
  private workspacePath: string;
  private broadcastTimer?: ReturnType<typeof setInterval>;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.config = {
      enabled: false,
      peers: [],
      discovery: {
        mode: 'workspace',
        broadcast: false,
        broadcastIntervalMs: 60000,
      },
    };
  }

  /**
   * Load discovery configuration from workspace config.
   */
  async load(): Promise<void> {
    const configPath = path.join(this.workspacePath, 'config.yaml');
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const config = yaml.load(content) as Record<string, unknown>;
      const a2aConfig = config['a2a'] as Record<string, unknown> | undefined;

      if (a2aConfig) {
        const discoveryConfig = (a2aConfig['discovery'] as Record<string, unknown>) ?? {};
        this.config = {
          enabled: (a2aConfig['enabled'] as boolean) ?? false,
          peers: this.parsePeers(a2aConfig['peers']),
          discovery: {
            mode: (discoveryConfig['mode'] as 'workspace' | 'network' | 'both') ?? 'workspace',
            broadcast: (discoveryConfig['broadcast'] as boolean) ?? false,
            broadcastIntervalMs: (discoveryConfig['broadcastIntervalMs'] as number) ?? 60000,
          },
        };
      }
    } catch {
      // Config file doesn't exist or is invalid - use defaults
    }
  }

  /**
   * Save discovery configuration to workspace config.
   */
  async save(): Promise<void> {
    const configPath = path.join(this.workspacePath, 'config.yaml');
    let config: Record<string, unknown> = {};

    try {
      const content = await fs.readFile(configPath, 'utf-8');
      config = yaml.load(content) as Record<string, unknown>;
    } catch {
      // File doesn't exist - create new
    }

    config['a2a'] = {
      enabled: this.config.enabled,
      peers: this.config.peers.map(p => ({
        name: p.name,
        url: p.url,
        authToken: p.authToken,
        timeoutMs: p.timeoutMs,
        capabilities: p.capabilities,
      })),
      discovery: {
        mode: this.config.discovery.mode,
        broadcast: this.config.discovery.broadcast,
        broadcastIntervalMs: this.config.discovery.broadcastIntervalMs,
      },
    };

    await fs.writeFile(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf-8');
  }

  /**
   * Start discovery and connect to configured peers.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) return;

    // Connect to configured peers
    for (const peerConfig of this.config.peers) {
      await this.addPeer(peerConfig);
    }

    // Start broadcast if enabled
    if (this.config.discovery.broadcast) {
      this.startBroadcast();
    }
  }

  /**
   * Stop discovery and disconnect from peers.
   */
  async stop(): Promise<void> {
    this.stopBroadcast();
    this.peers.clear();
  }

  /**
   * Add a peer dynamically.
   */
  async addPeer(config: A2APeerConfig): Promise<A2ADiscoveredPeer> {
    const client = createA2AClient(config.url, {
      authToken: config.authToken,
      timeoutMs: config.timeoutMs,
    });

    const peer: A2ADiscoveredPeer = {
      config,
      client,
      lastSeen: Date.now(),
      reachable: false,
    };

    // Try to discover the peer
    try {
      peer.card = await client.discover();
      peer.reachable = true;
      peer.lastSeen = Date.now();
    } catch {
      // Peer not reachable - still add it for later retry
    }

    this.peers.set(config.name, peer);
    return peer;
  }

  /**
   * Remove a peer.
   */
  removePeer(name: string): boolean {
    return this.peers.delete(name);
  }

  /**
   * Get a specific peer.
   */
  getPeer(name: string): A2ADiscoveredPeer | undefined {
    return this.peers.get(name);
  }

  /**
   * Get all discovered peers.
   */
  getPeers(): A2ADiscoveredPeer[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get only reachable peers.
   */
  getReachablePeers(): A2ADiscoveredPeer[] {
    return this.getPeers().filter(p => p.reachable);
  }

  /**
   * Find peers by capability.
   */
  findPeersByCapability(capability: string): A2ADiscoveredPeer[] {
    return this.getReachablePeers().filter(p => {
        const caps = p.config.capabilities ?? p.card?.skills.map((s: { id: string }) => s.id) ?? [];
      return caps.includes(capability);
    });
  }

  /**
   * Find peers by skill.
   */
  findPeersBySkill(skillId: string): A2ADiscoveredPeer[] {
    return this.getReachablePeers().filter(p => {
      return p.card?.skills.some((s: { id: string }) => s.id === skillId) ?? false;
    });
  }

  /**
   * Refresh peer connectivity.
   */
  async refresh(): Promise<void> {
    for (const [name, peer] of this.peers) {
      try {
        peer.card = await peer.client.discover();
        peer.reachable = true;
        peer.lastSeen = Date.now();
      } catch {
        peer.reachable = false;
      }
    }
  }

  /**
   * Get discovery status.
   */
  getStatus(): A2ADiscoveryStatus {
    const peers = this.getPeers();
    return {
      enabled: this.config.enabled,
      mode: this.config.discovery.mode,
      peersConfigured: this.config.peers.length,
      peersDiscovered: peers.length,
      peersReachable: peers.filter(p => p.reachable).length,
    };
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  private parsePeers(raw: unknown): A2APeerConfig[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map(p => ({
        name: (p['name'] as string) ?? '',
        url: (p['url'] as string) ?? '',
        authToken: p['authToken'] as string | undefined,
        timeoutMs: p['timeoutMs'] as number | undefined,
        capabilities: Array.isArray(p['capabilities']) ? p['capabilities'] as string[] : [],
      }))
      .filter(p => p.name && p.url);
  }

  private startBroadcast(): void {
    if (this.broadcastTimer) return;

    this.broadcastTimer = setInterval(() => {
      // Broadcast agent availability (placeholder for actual network broadcast)
      console.log('[A2A Discovery] Broadcasting availability...');
    }, this.config.discovery.broadcastIntervalMs ?? 60000);
  }

  private stopBroadcast(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: Create Discovery from Workspace
// ---------------------------------------------------------------------------

export async function createA2ADiscovery(
  workspacePath: string,
): Promise<A2ADiscovery> {
  const discovery = new A2ADiscovery(workspacePath);
  await discovery.load();
  return discovery;
}
