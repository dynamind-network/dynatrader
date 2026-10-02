import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { MouseRegion } from '../input/MouseInputProvider.js';

interface MCPServerInfo {
  name: string;
  command: string;
  args: string[];
  status: 'connected' | 'disconnected' | 'error';
  toolCount?: number;
  error?: string;
}

interface MCPScreenProps {
  servers: MCPServerInfo[];
  onConnect: (serverName: string) => void;
  onDisconnect: (serverName: string) => void;
  onSelect: (serverName: string) => void;
  onBack: () => void;
  selectedIndex: number;
  onSelectedIndexChange?: (index: number) => void;
}

function statusDot(status: MCPServerInfo['status']) {
  if (status === 'connected') return { symbol: '●', color: 'green' as const };
  if (status === 'error') return { symbol: '●', color: 'red' as const };
  return { symbol: '○', color: 'gray' as const };
}

export function MCPScreen({ servers, selectedIndex, onSelectedIndexChange }: MCPScreenProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="cyan" bold>
          MCP servers
        </Text>
        <Text dimColor>↑↓ navigate · Enter connect/disconnect · Esc back</Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
        <Text dimColor>Manage MCP server connections</Text>

        <Box flexDirection="column" marginTop={1}>
          {servers.length === 0 ? (
            <Text dimColor>No MCP servers configured.</Text>
          ) : (
            servers.map((server, index) => {
              const selected = index === selectedIndex;
              const dot = statusDot(server.status);

              return (
                <MouseRegion key={server.name} flexDirection="row" onClick={() => onSelectedIndexChange?.(index)}>
                  <Box justifyContent="space-between" flexDirection="row" flexGrow={1}>
                  <Box>
                    <Text color={selected ? 'cyan' : 'gray'}>{selected ? '>' : ' '}</Text>
                    <Text color={dot.color}>{dot.symbol} </Text>
                    <Text color={selected ? 'cyan' : 'white'} bold={selected}>
                      {server.name}
                    </Text>
                    {server.status === 'connected' && server.toolCount !== undefined && (
                      <Text dimColor>{` (${server.toolCount} tools)`}</Text>
                    )}
                    {server.status === 'error' && server.error && (
                      <Text color="red">{` — ${server.error}`}</Text>
                    )}
                  </Box>
                  </Box>
                </MouseRegion>
              );
            })
          )}
        </Box>
      </Box>
    </Box>
  );
}

export default MCPScreen;

