import React, { useState } from 'react';
import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import { useWallet } from '../../contexts/WalletContext.js';

interface SettingsScreenProps {
  onBack: () => void;
  showThinking: boolean;
  onToggleThinking: () => void;
}

type SettingsMenuItem =
  'thinking' | 'privateKey' | 'mainAddress' | 'anthropicKey' | 'openaiKey' | 'hyperliquidKey';

const SETTINGS_MENU: { id: SettingsMenuItem; label: string; editable: boolean }[] = [
  { id: 'thinking', label: 'Thinking visibility', editable: true },
  { id: 'privateKey', label: 'PRIVATE_KEY', editable: false },
  { id: 'mainAddress', label: 'MAIN_ADDRESS', editable: false },
  { id: 'anthropicKey', label: 'ANTHROPIC_API_KEY', editable: false },
  { id: 'openaiKey', label: 'OPENAI_API_KEY', editable: false },
  { id: 'hyperliquidKey', label: 'HYPERLIQUID_PRIVATE_KEY', editable: false },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text color="gray" bold>
      {children}
    </Text>
  );
}

function KeyValue({
  label,
  value,
  labelWidth = 22,
}: {
  label: string;
  value: string;
  labelWidth?: number;
}) {
  return (
    <Box>
      <Box width={labelWidth}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

export function SettingsScreen({ onBack, showThinking, onToggleThinking }: SettingsScreenProps) {
  const { isConnected, address, portfolio, error } = useWallet();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev - 1 + SETTINGS_MENU.length) % SETTINGS_MENU.length);
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => (prev + 1) % SETTINGS_MENU.length);
      return;
    }

    if (key.return) {
      const selectedItem = SETTINGS_MENU[selectedIndex];
      if (selectedItem?.id === 'thinking') {
        onToggleThinking();
      }
      return;
    }

    if (input.toLowerCase() === 't') {
      onToggleThinking();
    }
  });

  const formatAddress = (addr: string) =>
    addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'Not set';

  const envInfo = {
    privateKey: process.env.PRIVATE_KEY ? 'Set (hidden)' : 'Not set',
    mainAddress: process.env.MAIN_ADDRESS || 'Not set',
    anthropicKey: process.env.ANTHROPIC_API_KEY ? 'Set (hidden)' : 'Not set',
    openaiKey: process.env.OPENAI_API_KEY ? 'Set (hidden)' : 'Not set',
    hyperliquidKey: process.env.HYPERLIQUID_PRIVATE_KEY ? 'Set (hidden)' : 'Not set',
  };

  const displayValueFor = (id: SettingsMenuItem): string => {
    switch (id) {
      case 'thinking':
        return showThinking ? 'ON' : 'OFF';
      case 'privateKey':
        return envInfo.privateKey;
      case 'mainAddress':
        return envInfo.mainAddress !== 'Not set' ? formatAddress(envInfo.mainAddress) : 'Not set';
      case 'anthropicKey':
        return envInfo.anthropicKey;
      case 'openaiKey':
        return envInfo.openaiKey;
      case 'hyperliquidKey':
        return envInfo.hyperliquidKey;
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="cyan" bold>
          Settings
        </Text>
        <Text dimColor>Ctrl+S · Esc to return</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <SectionTitle>Wallet</SectionTitle>
        <Box marginTop={1} flexDirection="column">
          <KeyValue label="Status" value={isConnected ? 'CONNECTED' : 'DISCONNECTED'} />
          <KeyValue label="Address" value={isConnected ? address : 'Not connected'} />
          {portfolio && (
            <>
              <KeyValue
                label="Total value"
                value={`$${portfolio.totalValueUsd?.toLocaleString(undefined, { maximumFractionDigits: 2 }) || '0.00'}`}
              />
              <KeyValue label="Chains" value={portfolio.chains?.join(', ') || 'None'} />
            </>
          )}
          {error && <KeyValue label="Error" value={error} />}
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <SectionTitle>Environment</SectionTitle>
        <Box marginTop={1} flexDirection="column">
          <KeyValue label="PRIVATE_KEY" value={envInfo.privateKey} />
          <KeyValue
            label="MAIN_ADDRESS"
            value={
              envInfo.mainAddress !== 'Not set' ? formatAddress(envInfo.mainAddress) : 'Not set'
            }
          />
          <KeyValue label="ANTHROPIC_API_KEY" value={envInfo.anthropicKey} />
          <KeyValue label="OPENAI_API_KEY" value={envInfo.openaiKey} />
          <KeyValue label="HYPERLIQUID_PRIVATE_KEY" value={envInfo.hyperliquidKey} />
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <SectionTitle>System</SectionTitle>
        <Box marginTop={1} flexDirection="column">
          <KeyValue label="Platform" value={process.platform} />
          <KeyValue label="Node version" value={process.version} />
          <KeyValue
            label="Memory usage"
            value={`${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`}
          />
          <KeyValue label="Uptime" value={`${Math.round(process.uptime())}s`} />
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <SectionTitle>Quick actions</SectionTitle>
        <Box marginTop={1} flexDirection="column">
          {SETTINGS_MENU.map((item, index) => {
            const selected = index === selectedIndex;
            const displayValue = displayValueFor(item.id);

            return (
              <Box key={item.id}>
                <Text color={selected ? 'cyan' : 'gray'}>{selected ? '>' : ' '}</Text>
                <Box width={24}>
                  <Text color={selected ? 'white' : 'gray'}>{item.label}</Text>
                </Box>
                <Text
                  color={item.id === 'thinking' ? (showThinking ? 'green' : 'yellow') : 'white'}
                >
                  {displayValue}
                </Text>
                {selected && item.editable && <Text dimColor> Enter toggles</Text>}
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Use ↑/↓ to navigate, Enter to toggle the selected setting.</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <SectionTitle>Keyboard shortcuts</SectionTitle>
        <Box marginTop={1} flexDirection="column">
          <KeyValue label="↑ / ↓" value="Navigate menu items" />
          <KeyValue label="Enter" value="Toggle selected item" />
          <KeyValue label="T" value="Toggle thinking" />
          <KeyValue label="Esc" value="Return to chat" />
        </Box>
      </Box>
    </Box>
  );
}

export default SettingsScreen;

