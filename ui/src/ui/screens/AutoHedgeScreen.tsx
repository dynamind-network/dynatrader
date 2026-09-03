import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import type { AutoHedgeStatus, AutoHedgePosition } from './types.js';
import { useWallet } from '../../contexts/WalletContext.js';

interface AutoHedgeScreenProps {
  onBack: () => void;
}

interface LogEntry {
  timestamp: Date;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
}

export function AutoHedgeScreen({ onBack }: AutoHedgeScreenProps) {
  const { isConnected, address, walletService } = useWallet();
  const [status, setStatus] = useState<AutoHedgeStatus>('stopped');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [positions, setPositions] = useState<AutoHedgePosition[]>([]);
  const [totalPnl, setTotalPnl] = useState(0);
  const [realizedPnl, setRealizedPnl] = useState(0);
  const [unrealizedPnl, setUnrealizedPnl] = useState(0);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [selectedAction, setSelectedAction] = useState(0);
  const processRef = useRef<ChildProcess | null>(null);
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [accountValue, setAccountValue] = useState(0);
  const [tradingMode, setTradingMode] = useState<'paper' | 'live'>('live');

  const AUTOHEDGE_PATH = 'D:\\Trading\\AutoHedgefund';
  const MAX_LOGS = 100;
  const VISIBLE_LOGS = 12;

  const actions = [
    {
      key: 'start',
      label: 'START LIVE',
      enabled: (status === 'stopped' || status === 'error') && isConnected,
    },
    { key: 'stop', label: 'STOP', enabled: status === 'running' || status === 'paused' },
    {
      key: 'pause',
      label: status === 'paused' ? 'RESUME' : 'PAUSE',
      enabled: status === 'running' || status === 'paused',
    },
  ];

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => {
      const newLogs = [...prev, { timestamp: new Date(), level, message }];
      if (newLogs.length > MAX_LOGS) {
        return newLogs.slice(-MAX_LOGS);
      }
      return newLogs;
    });
  }, []);

  const parseLogLine = useCallback(
    (line: string): { level: LogEntry['level']; message: string } => {
      const upperLine = line.toUpperCase();
      if (
        upperLine.includes('ERROR') ||
        upperLine.includes('EXCEPTION') ||
        upperLine.includes('FAILED')
      ) {
        return { level: 'ERROR', message: line };
      }
      if (upperLine.includes('WARN') || upperLine.includes('WARNING')) {
        return { level: 'WARN', message: line };
      }
      if (upperLine.includes('DEBUG')) {
        return { level: 'DEBUG', message: line };
      }
      return { level: 'INFO', message: line };
    },
    []
  );

  const parsePositionFromLog = useCallback((line: string) => {
    // Parse position updates from AutoHedgeFund output
    // Expected shape: "Position: <symbol> <LONG|SHORT> <size> @ <entry> | Current: <price> | PnL: <value>"
    const posMatch = line.match(/Position:\s*(\w+)\s+(LONG|SHORT)\s+([\d.]+)\s*@\s*([\d.]+)/i);
    if (posMatch) {
      const currentMatch = line.match(/Current:\s*([\d.]+)/i);
      const pnlMatch = line.match(/PnL:\s*([+-]?[\d.]+)/i);

      const position: AutoHedgePosition = {
        symbol: posMatch[1],
        side: posMatch[2].toLowerCase() as 'long' | 'short',
        size: parseFloat(posMatch[3]),
        entryPrice: parseFloat(posMatch[4]),
        currentPrice: currentMatch ? parseFloat(currentMatch[1]) : parseFloat(posMatch[4]),
        unrealizedPnl: pnlMatch ? parseFloat(pnlMatch[1]) : 0,
        leverage: 1,
      };

      setPositions((prev) => {
        const existing = prev.findIndex((p) => p.symbol === position.symbol);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = position;
          return updated;
        }
        return [...prev, position];
      });
    }

    // Parse PnL updates
    const pnlTotalMatch = line.match(/Total PnL:\s*\$?([+-]?[\d.]+)/i);
    if (pnlTotalMatch) {
      setTotalPnl(parseFloat(pnlTotalMatch[1]));
    }

    const realizedMatch = line.match(/Realized:\s*\$?([+-]?[\d.]+)/i);
    if (realizedMatch) {
      setRealizedPnl(parseFloat(realizedMatch[1]));
    }

    const unrealizedMatch = line.match(/Unrealized:\s*\$?([+-]?[\d.]+)/i);
    if (unrealizedMatch) {
      setUnrealizedPnl(parseFloat(unrealizedMatch[1]));
    }
  }, []);

  const startBot = useCallback(() => {
    if (processRef.current) {
      addLog('WARN', 'Bot is already running');
      return;
    }

    if (!isConnected) {
      addLog('ERROR', 'Wallet not connected. Set PRIVATE_KEY and MAIN_ADDRESS.');
      return;
    }

    addLog('INFO', 'Starting AutoHedgeFund LIVE TRADING...');
    addLog('WARN', 'WARNING: Real trades will be executed!');
    addLog('INFO', `Using wallet: ${address}`);
    addLog('INFO', 'Risk Limits: 25% portfolio, 10x max leverage, 10% daily loss limit');
    setStatus('running');
    setStartTime(new Date());
    setPositions([]);
    setTotalPnl(0);
    setRealizedPnl(0);
    setUnrealizedPnl(0);

    // Get private key from environment (same as wallet context uses)
    const privateKey = process.env.PRIVATE_KEY || '';

    try {
      // Pass wallet credentials to AutoHedgeFund live trading bot
      const envVars: Record<string, string> = {
        ...(process.env as Record<string, string>),
        HYPERLIQUID_PRIVATE_KEY: privateKey,
        MAIN_ADDRESS: address,
        LIVE_TRADING_ENABLED: 'true',
      };

      // Use live_trading_bot.py for live trading
      const proc = spawn('python', ['live_trading_bot.py'], {
        cwd: AUTOHEDGE_PATH,
        shell: true,
        env: envVars,
      });

      processRef.current = proc;

      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data
          .toString()
          .split('\n')
          .filter((l) => l.trim());
        lines.forEach((line) => {
          const { level, message } = parseLogLine(line);
          addLog(level, message);
          parsePositionFromLog(line);
        });
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const lines = data
          .toString()
          .split('\n')
          .filter((l) => l.trim());
        lines.forEach((line) => {
          addLog('ERROR', line);
        });
      });

      proc.on('close', (code) => {
        addLog('INFO', `AutoHedgeFund exited with code ${code}`);
        setStatus(code === 0 ? 'stopped' : 'error');
        processRef.current = null;
      });

      proc.on('error', (err) => {
        addLog('ERROR', `Failed to start: ${err.message}`);
        setStatus('error');
        processRef.current = null;
      });
    } catch (err: any) {
      addLog('ERROR', `Failed to start AutoHedgeFund: ${err.message}`);
      setStatus('error');
    }
  }, [addLog, parseLogLine, parsePositionFromLog, isConnected, address]);

  const stopBot = useCallback(() => {
    if (!processRef.current) {
      addLog('WARN', 'Bot is not running');
      return;
    }

    addLog('INFO', 'Stopping AutoHedgeFund...');
    processRef.current.kill('SIGTERM');

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (processRef.current) {
        processRef.current.kill('SIGKILL');
        processRef.current = null;
        setStatus('stopped');
      }
    }, 5000);
  }, [addLog]);

  const togglePause = useCallback(() => {
    if (!processRef.current) {
      addLog('WARN', 'Bot is not running');
      return;
    }

    if (status === 'paused') {
      addLog('INFO', 'Resuming AutoHedgeFund...');
      processRef.current.kill('SIGCONT');
      setStatus('running');
    } else {
      addLog('INFO', 'Pausing AutoHedgeFund...');
      processRef.current.kill('SIGSTOP');
      setStatus('paused');
    }
  }, [status, addLog]);

  const toggleMode = useCallback(() => {
    if (status !== 'stopped') {
      addLog('WARN', 'Stop the bot before changing trading mode');
      return;
    }
    const newMode = tradingMode === 'paper' ? 'live' : 'paper';
    setTradingMode(newMode);
    addLog('INFO', `Trading mode changed to ${newMode.toUpperCase()}`);
  }, [status, tradingMode, addLog]);

  const executeAction = useCallback(() => {
    const action = actions[selectedAction];
    if (!action.enabled) return;

    switch (action.key) {
      case 'start':
        startBot();
        break;
      case 'stop':
        stopBot();
        break;
      case 'pause':
        togglePause();
        break;
      case 'mode':
        toggleMode();
        break;
    }
  }, [selectedAction, actions, startBot, stopBot, togglePause, toggleMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (processRef.current) {
        processRef.current.kill('SIGTERM');
      }
    };
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }

    if (key.leftArrow) {
      setSelectedAction((prev) => Math.max(0, prev - 1));
    } else if (key.rightArrow) {
      setSelectedAction((prev) => Math.min(actions.length - 1, prev + 1));
    } else if (key.return) {
      executeAction();
    } else if (key.upArrow) {
      setLogScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setLogScrollOffset((prev) => Math.min(Math.max(0, logs.length - VISIBLE_LOGS), prev + 1));
    }

    // Number shortcuts
    if (input === '1' && actions[0]?.enabled) {
      setSelectedAction(0);
      startBot();
    } else if (input === '2' && actions[1]?.enabled) {
      setSelectedAction(1);
      stopBot();
    } else if (input === '3' && actions[2]?.enabled) {
      setSelectedAction(2);
      togglePause();
    } else if (input === '4' && actions[3]?.enabled) {
      setSelectedAction(3);
      toggleMode();
    }
  });

  const getStatusColor = () => {
    switch (status) {
      case 'running':
        return 'green';
      case 'paused':
        return 'yellow';
      case 'error':
        return 'red';
      default:
        return 'gray';
    }
  };

  const getUptime = () => {
    if (!startTime) return '--:--:--';
    const diff = Date.now() - startTime.getTime();
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getLogColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'ERROR':
        return 'red';
      case 'WARN':
        return 'yellow';
      case 'DEBUG':
        return 'gray';
      default:
        return 'white';
    }
  };

  const visibleLogs = logs.slice(logScrollOffset, logScrollOffset + VISIBLE_LOGS);

  const formattedAddress = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : 'Not connected';

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          AUTOHEDGEFUND CONTROL [F11]
        </Text>
        <Text dimColor> - </Text>
        <Text color={getStatusColor()} bold>
          {status.toUpperCase()}
        </Text>
        <Text dimColor> | </Text>
        <Text color={tradingMode === 'paper' ? 'yellow' : 'red'} bold>
          {tradingMode === 'paper' ? 'PAPER' : 'LIVE'}
        </Text>
        {startTime && <Text dimColor> | Uptime: {getUptime()}</Text>}
      </Box>

      {/* Wallet Info */}
      <Box marginBottom={1}>
        <Text dimColor>Wallet: </Text>
        <Text color={isConnected ? 'green' : 'red'}>
          {isConnected ? formattedAddress : 'Not connected'}
        </Text>
        {!isConnected && (
          <Text color="red"> (Set PRIVATE_KEY and MAIN_ADDRESS to enable trading)</Text>
        )}
      </Box>

      <Text dimColor>{'='.repeat(80)}</Text>

      {/* Control Panel */}
      <Box marginY={1}>
        <Text bold>Controls: </Text>
        {actions.map((action, idx) => (
          <Box key={action.key} marginRight={2}>
            <Text
              color={!action.enabled ? 'gray' : selectedAction === idx ? 'black' : 'white'}
              backgroundColor={selectedAction === idx ? 'cyan' : undefined}
              bold={selectedAction === idx}
              dimColor={!action.enabled}
            >
              {` [${idx + 1}] ${action.label} `}
            </Text>
          </Box>
        ))}
        <Text dimColor> | Arrow keys to select, Enter to execute</Text>
      </Box>

      <Text dimColor>{'-'.repeat(80)}</Text>

      {/* P&L Summary */}
      <Box marginY={1} flexDirection="column">
        <Text color="yellow" bold>
          P&L Summary
        </Text>
        <Box>
          <Box width={25}>
            <Text>Total P&L: </Text>
            <Text color={totalPnl >= 0 ? 'green' : 'red'} bold>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </Text>
          </Box>
          <Box width={25}>
            <Text>Realized: </Text>
            <Text color={realizedPnl >= 0 ? 'green' : 'red'}>
              {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
            </Text>
          </Box>
          <Box width={25}>
            <Text>Unrealized: </Text>
            <Text color={unrealizedPnl >= 0 ? 'green' : 'red'}>
              {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
            </Text>
          </Box>
        </Box>
      </Box>

      <Text dimColor>{'-'.repeat(80)}</Text>

      {/* Positions */}
      <Box marginY={1} flexDirection="column">
        <Text color="yellow" bold>
          Active Positions ({positions.length})
        </Text>
        {positions.length === 0 ? (
          <Text dimColor>No active positions</Text>
        ) : (
          <>
            <Box>
              <Box width={10}>
                <Text bold>Symbol</Text>
              </Box>
              <Box width={8}>
                <Text bold>Side</Text>
              </Box>
              <Box width={12}>
                <Text bold>Size</Text>
              </Box>
              <Box width={12}>
                <Text bold>Entry</Text>
              </Box>
              <Box width={12}>
                <Text bold>Current</Text>
              </Box>
              <Box width={12}>
                <Text bold>PnL</Text>
              </Box>
            </Box>
            {positions.map((pos, idx) => (
              <Box key={`${pos.symbol}-${idx}`}>
                <Box width={10}>
                  <Text color="white" bold>
                    {pos.symbol}
                  </Text>
                </Box>
                <Box width={8}>
                  <Text color={pos.side === 'long' ? 'green' : 'red'}>
                    {pos.side.toUpperCase()}
                  </Text>
                </Box>
                <Box width={12}>
                  <Text>{pos.size.toFixed(4)}</Text>
                </Box>
                <Box width={12}>
                  <Text dimColor>${pos.entryPrice.toFixed(2)}</Text>
                </Box>
                <Box width={12}>
                  <Text>${pos.currentPrice.toFixed(2)}</Text>
                </Box>
                <Box width={12}>
                  <Text color={pos.unrealizedPnl >= 0 ? 'green' : 'red'}>
                    {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                  </Text>
                </Box>
              </Box>
            ))}
          </>
        )}
      </Box>

      <Text dimColor>{'-'.repeat(80)}</Text>

      {/* Logs */}
      <Box marginY={1} flexDirection="column">
        <Box>
          <Text color="yellow" bold>
            Logs
          </Text>
          <Text dimColor>
            {' '}
            ({logs.length} entries, showing {logScrollOffset + 1}-
            {Math.min(logScrollOffset + VISIBLE_LOGS, logs.length)})
          </Text>
        </Box>
        <Box flexDirection="column" height={VISIBLE_LOGS}>
          {visibleLogs.length === 0 ? (
            <Text dimColor>No logs yet. Start the bot to see output.</Text>
          ) : (
            visibleLogs.map((log, idx) => (
              <Box key={idx}>
                <Text dimColor>{log.timestamp.toLocaleTimeString()}</Text>
                <Text color={getLogColor(log.level)}> [{log.level.padEnd(5)}] </Text>
                <Text>{log.message.substring(0, 60)}</Text>
              </Box>
            ))
          )}
        </Box>
        {logs.length > VISIBLE_LOGS && <Text dimColor>Use Up/Down arrows to scroll logs</Text>}
      </Box>

      {/* Footer */}
      <Text dimColor>{'='.repeat(80)}</Text>
      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor> to return | </Text>
        <Text color="yellow">1/2/3/4</Text>
        <Text dimColor> quick actions | </Text>
        <Text color="yellow">Up/Down</Text>
        <Text dimColor> scroll logs</Text>
      </Box>
      <Box>
        <Text dimColor>Actions: </Text>
        <Text color="green">[1]</Text>
        <Text dimColor> Start </Text>
        <Text color="red">[2]</Text>
        <Text dimColor> Stop </Text>
        <Text color="yellow">[3]</Text>
        <Text dimColor> Pause/Resume </Text>
        <Text color="magenta">[4]</Text>
        <Text dimColor> Toggle Paper/Live</Text>
      </Box>
    </Box>
  );
}

export default AutoHedgeScreen;
