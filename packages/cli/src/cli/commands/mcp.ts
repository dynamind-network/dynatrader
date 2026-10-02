/**
 * CLI Command: mcp
 *
 * Manages workspace MCP server configuration. The runtime consumes this
 * config directly at startup; this command is the operator-facing edit surface.
 */

import { bold, cyan, green, red, yellow, dim, printSeparator } from '../utils';
import { loadConfig, saveConfig, type DynaConfig } from '@dyna/core/cli';

type McpFlags = Record<string, string | boolean>;

type McpServer = DynaConfig['mcp']['servers'][number];

function flagString(flags: McpFlags | undefined, key: string): string | undefined {
  const value = flags?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function flagBoolean(flags: McpFlags | undefined, key: string): boolean | undefined {
  const value = flags?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(lowered)) return false;
  return undefined;
}

function parseStringList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseEnv(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, (value as string).trim()] as const)
          .filter(([, value]) => value.length > 0),
      );
    }
  } catch {
    // Fall through to KEY=VALUE parsing.
  }

  const env: Record<string, string> = {};
  for (const pair of trimmed.split(',')) {
    const [key, ...rest] = pair.split('=');
    const normalizedKey = key?.trim();
    const normalizedValue = rest.join('=').trim();
    if (normalizedKey && normalizedValue) {
      env[normalizedKey] = normalizedValue;
    }
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

function formatServer(server: McpServer): string {
  const transport = server.transport === 'http'
    ? `http ${server.url ?? dim('(missing url)')}`
    : `stdio ${server.command ?? dim('(missing command)')}`;
  const enabled = server.enabled === false ? red('disabled') : green('enabled');
  return `${server.name} [${enabled}] ${transport}`;
}

function normalizeServer(
  existing: McpServer | undefined,
  flags: McpFlags,
  name: string,
): McpServer {
  const transportRaw = flagString(flags, 'transport');
  const transport = transportRaw === 'http'
    ? 'http'
    : transportRaw === 'stdio'
      ? 'stdio'
      : existing?.transport ?? 'stdio';
  const enabled = flagBoolean(flags, 'enabled');
  const disabled = flagBoolean(flags, 'disabled');

  return {
    name,
    transport,
    command: flagString(flags, 'command') ?? existing?.command,
    args: parseStringList(flagString(flags, 'args')) ?? existing?.args,
    url: flagString(flags, 'url') ?? existing?.url,
    env: parseEnv(flagString(flags, 'env')) ?? existing?.env,
    envFilter: parseStringList(flagString(flags, 'env-filter')) ?? existing?.envFilter,
    includeTools: parseStringList(flagString(flags, 'include-tools')) ?? existing?.includeTools,
    excludeTools: parseStringList(flagString(flags, 'exclude-tools')) ?? existing?.excludeTools,
    enabled: disabled === true ? false : enabled ?? existing?.enabled ?? true,
  };
}

function validateServer(server: McpServer): string | null {
  if (!server.name.trim()) {
    return 'server name is required';
  }
  if (server.transport === 'http') {
    if (!server.url?.trim()) {
      return 'http servers require --url';
    }
  } else if (!server.command?.trim()) {
    return 'stdio servers require --command';
  }
  return null;
}

function printServer(server: McpServer): void {
  console.log(`  ${bold(server.name)}`);
  console.log(`    Transport: ${server.transport}`);
  console.log(`    State:     ${server.enabled === false ? red('disabled') : green('enabled')}`);

  if (server.transport === 'http') {
    console.log(`    URL:       ${server.url ?? dim('n/a')}`);
  } else {
    console.log(`    Command:   ${server.command ?? dim('n/a')}`);
    console.log(`    Args:      ${server.args?.length ? server.args.join(' ') : dim('n/a')}`);
  }

  console.log(`    Env:       ${server.env ? Object.keys(server.env).length : 0} variable(s)`);
  console.log(`    EnvFilter: ${server.envFilter?.length ? server.envFilter.join(', ') : dim('n/a')}`);
  console.log(`    Include:   ${server.includeTools?.length ? server.includeTools.join(', ') : dim('n/a')}`);
  console.log(`    Exclude:   ${server.excludeTools?.length ? server.excludeTools.join(', ') : dim('n/a')}`);
}

export async function cmdMcp(
  workspacePath: string,
  sub: string,
  args: string[],
  flags: McpFlags = {},
): Promise<void> {
  const config = await loadConfig(workspacePath);
  const servers = [...config.mcp.servers];

  switch (sub) {
    case 'list':
    case 'status': {
      console.log();
      console.log(bold(cyan('MCP Servers')));
      printSeparator();

      if (servers.length === 0) {
        console.log(yellow('  No MCP servers configured.'));
        console.log();
        return;
      }

      for (const server of servers) {
        console.log(`  ${formatServer(server)}`);
      }
      console.log();
      break;
    }

    case 'inspect':
    case 'show': {
      const name = args[0];
      if (!name) {
        console.log(red('Error: server name is required.'));
        console.log(dim('Usage: dynatrader mcp inspect <name>'));
        return;
      }

      const server = servers.find((item) => item.name === name);
      if (!server) {
        console.log(red(`MCP server not found: ${name}`));
        return;
      }

      console.log();
      console.log(bold(cyan('MCP Server Details')));
      printSeparator();
      printServer(server);
      console.log();
      console.log(dim('  Effective configuration:'));
      console.log(JSON.stringify(server, null, 2));
      console.log();
      break;
    }

    case 'add':
    case 'create': {
      const name = args[0]?.trim();
      if (!name) {
        console.log(red('Error: server name is required.'));
        console.log(dim('Usage: dynatrader mcp add <name> --transport http --url https://example.com/mcp'));
        return;
      }
      if (servers.some((item) => item.name === name)) {
        console.log(red(`MCP server already exists: ${name}`));
        console.log(dim('Use `mcp update` to modify it.'));
        return;
      }

      const server = normalizeServer(undefined, flags, name);
      const validationError = validateServer(server);
      if (validationError) {
        console.log(red(`Error: ${validationError}`));
        return;
      }

      config.mcp.servers = [...servers, server];
      await saveConfig(workspacePath, config);

      console.log(green(`MCP server added: ${name}`));
      printServer(server);
      console.log();
      break;
    }

    case 'update':
    case 'edit': {
      const name = args[0]?.trim();
      if (!name) {
        console.log(red('Error: server name is required.'));
        console.log(dim('Usage: dynatrader mcp update <name> [flags]'));
        return;
      }

      const index = servers.findIndex((item) => item.name === name);
      if (index === -1) {
        console.log(red(`MCP server not found: ${name}`));
        return;
      }

      const updated = normalizeServer(servers[index], flags, name);
      const validationError = validateServer(updated);
      if (validationError) {
        console.log(red(`Error: ${validationError}`));
        return;
      }

      servers[index] = updated;
      config.mcp.servers = servers;
      await saveConfig(workspacePath, config);

      console.log(green(`MCP server updated: ${name}`));
      printServer(updated);
      console.log();
      break;
    }

    case 'remove':
    case 'delete': {
      const name = args[0]?.trim();
      if (!name) {
        console.log(red('Error: server name is required.'));
        console.log(dim('Usage: dynatrader mcp remove <name>'));
        return;
      }

      const next = servers.filter((item) => item.name !== name);
      if (next.length === servers.length) {
        console.log(red(`MCP server not found: ${name}`));
        return;
      }

      config.mcp.servers = next;
      await saveConfig(workspacePath, config);
      console.log(green(`MCP server removed: ${name}`));
      break;
    }

    case 'enable':
    case 'disable': {
      const name = args[0]?.trim();
      if (!name) {
        console.log(red('Error: server name is required.'));
        console.log(dim(`Usage: dynatrader mcp ${sub} <name>`));
        return;
      }

      const index = servers.findIndex((item) => item.name === name);
      if (index === -1) {
        console.log(red(`MCP server not found: ${name}`));
        return;
      }

      servers[index] = {
        ...servers[index],
        enabled: sub === 'enable',
      };
      config.mcp.servers = servers;
      await saveConfig(workspacePath, config);
      console.log(sub === 'enable' ? green(`MCP server enabled: ${name}`) : yellow(`MCP server disabled: ${name}`));
      break;
    }

    case 'server': {
      console.log();
      console.log(bold(cyan('MCP Server Mode')));
      printSeparator();
      console.log(dim('DynaTrader exposes MCP server mode through the runtime daemon. This command manages the workspace server configuration that the daemon loads at startup.'));
      console.log(`  Configured servers: ${servers.length}`);
      console.log(`  Enabled servers:    ${servers.filter((server) => server.enabled !== false).length}`);
      console.log(`  Workspace:          ${workspacePath}`);
      console.log();
      break;
    }

    default: {
      console.log(red(`Unknown MCP subcommand: ${sub}`));
      console.log(dim('Usage: dynatrader mcp <list|inspect|add|update|remove|enable|disable|server> [args...]'));
    }
  }
}
