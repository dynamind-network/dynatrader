import { Box, Text } from '@dynatrader/ink/terminal';
import Conf from 'conf';
import React, { useEffect, useState } from 'react';

interface Alert {
  id: string;
  coin: string;
  condition: 'above' | 'below';
  targetPrice: number;
  currentPrice: number;
  triggered: boolean;
  createdAt: string;
}

interface AlertsScreenProps {
  onBack: () => void;
}

// Persistent alert storage using conf
const alertConfig = new Conf<{ alerts: Alert[] }>({
  projectName: 'dynamind-terminal',
  defaults: { alerts: [] },
});

// Export for use by chat commands
export function getAlerts(): Alert[] {
  return alertConfig.get('alerts') || [];
}

export function addAlert(coin: string, condition: 'above' | 'below', targetPrice: number): Alert {
  const alerts = getAlerts();
  const newAlert: Alert = {
    id: Date.now().toString(),
    coin: coin.toUpperCase(),
    condition,
    targetPrice,
    currentPrice: 0,
    triggered: false,
    createdAt: new Date().toISOString(),
  };
  alerts.push(newAlert);
  alertConfig.set('alerts', alerts);
  return newAlert;
}

export function removeAlert(id: string): boolean {
  const alerts = getAlerts();
  const filtered = alerts.filter((a) => a.id !== id);
  if (filtered.length < alerts.length) {
    alertConfig.set('alerts', filtered);
    return true;
  }
  return false;
}

export function clearTriggeredAlerts(): number {
  const alerts = getAlerts();
  const active = alerts.filter((a) => !a.triggered);
  const removed = alerts.length - active.length;
  alertConfig.set('alerts', active);
  return removed;
}

/**
 * F5 - Alerts Screen
 * Shows price alerts with persistent storage
 */
export function AlertsScreen({ onBack }: AlertsScreenProps) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    // Load alerts from persistent storage
    const stored = getAlerts();
    setAlerts(stored);
    updatePrices(stored);
    const interval = setInterval(() => updatePrices(), 10000);
    return () => clearInterval(interval);
  }, []);

  async function updatePrices(initialAlerts?: Alert[]) {
    try {
      const currentAlerts = initialAlerts || getAlerts();

      if (currentAlerts.length === 0) {
        setAlerts([]);
        setLoading(false);
        return;
      }

      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Market price API error: ${response.status}`);

      const mids = (await response.json()) as Record<string, string>;

      const updatedAlerts = currentAlerts.map((alert) => {
        const currentPrice = parseFloat(mids[alert.coin] || '0');
        const wasTriggered = alert.triggered;
        const isTriggered =
          alert.condition === 'above'
            ? currentPrice >= alert.targetPrice
            : currentPrice <= alert.targetPrice;

        return {
          ...alert,
          currentPrice,
          triggered: wasTriggered || isTriggered,
        };
      });

      // Save updated alerts to persistent storage
      alertConfig.set('alerts', updatedAlerts);
      setAlerts(updatedAlerts);
      setLastUpdate(new Date());
      setLoading(false);
    } catch (err) {
      setLoading(false);
    }
  }

  if (loading && alerts.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          ALERTS [F5]
        </Text>
        <Text dimColor>Loading alerts...</Text>
      </Box>
    );
  }

  const activeAlerts = alerts.filter((a) => !a.triggered);
  const triggeredAlerts = alerts.filter((a) => a.triggered);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          ALERTS [F5]
        </Text>
        <Text dimColor> Last update: {lastUpdate.toLocaleTimeString()}</Text>
      </Box>

      {/* Active Alerts */}
      <Box marginBottom={1}>
        <Text bold color="white">
          Active Alerts ({activeAlerts.length})
        </Text>
      </Box>

      {/* Column Headers */}
      <Box>
        <Box width={8}>
          <Text bold>Coin</Text>
        </Box>
        <Box width={12}>
          <Text bold>Condition</Text>
        </Box>
        <Box width={14}>
          <Text bold>Target</Text>
        </Box>
        <Box width={14}>
          <Text bold>Current</Text>
        </Box>
        <Box width={12}>
          <Text bold>Distance</Text>
        </Box>
        <Box width={10}>
          <Text bold>Status</Text>
        </Box>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(70)}</Text>
      </Box>

      {/* Alert Rows */}
      {activeAlerts.length === 0 ? (
        <Box marginBottom={1}>
          <Text dimColor>
            No active alerts. Use chat to create: "alert &lt;symbol&gt; above &lt;price&gt;"
          </Text>
        </Box>
      ) : (
        activeAlerts.map((alert) => {
          const distance =
            alert.currentPrice > 0
              ? ((alert.currentPrice - alert.targetPrice) / alert.targetPrice) * 100
              : 0;
          const distanceAbs = Math.abs(distance);

          return (
            <Box key={alert.id}>
              <Box width={8}>
                <Text color="white" bold>
                  {alert.coin}
                </Text>
              </Box>
              <Box width={12}>
                <Text color={alert.condition === 'above' ? 'green' : 'red'}>
                  {alert.condition.toUpperCase()}
                </Text>
              </Box>
              <Box width={14}>
                <Text color="yellow">${formatPrice(alert.targetPrice)}</Text>
              </Box>
              <Box width={14}>
                <Text color="white">${formatPrice(alert.currentPrice)}</Text>
              </Box>
              <Box width={12}>
                <Text color={distanceAbs < 5 ? 'yellow' : 'white'}>
                  {distance >= 0 ? '+' : ''}
                  {distance.toFixed(2)}%
                </Text>
              </Box>
              <Box width={10}>
                <Text color="cyan">WATCHING</Text>
              </Box>
            </Box>
          );
        })
      )}

      {/* Triggered Alerts */}
      {triggeredAlerts.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={1}>
            <Text bold color="green">
              Triggered Alerts ({triggeredAlerts.length})
            </Text>
          </Box>
          {triggeredAlerts.map((alert) => (
            <Box key={alert.id}>
              <Box width={8}>
                <Text color="white" bold>
                  {alert.coin}
                </Text>
              </Box>
              <Box width={12}>
                <Text dimColor>{alert.condition.toUpperCase()}</Text>
              </Box>
              <Box width={14}>
                <Text dimColor>${formatPrice(alert.targetPrice)}</Text>
              </Box>
              <Box width={14}>
                <Text color="green">${formatPrice(alert.currentPrice)}</Text>
              </Box>
              <Box width={12}>
                <Text dimColor>-</Text>
              </Box>
              <Box width={10}>
                <Text color="green" bold>
                  TRIGGERED
                </Text>
              </Box>
            </Box>
          ))}
        </>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(70)}</Text>
      </Box>
      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor>
          {' '}
          to return | Create: "alert &lt;symbol&gt; above &lt;price&gt;" | Clear: "clear alerts"
        </Text>
      </Box>
    </Box>
  );
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

export default AlertsScreen;

